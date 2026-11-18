import type { SingleDatabase } from "../src/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { upsertUser } from "../src/data/control-plane";
import { newControlMutationIdentity } from "../src/data/control-mutation";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  renameOrganisation,
  restoreOrganisation,
  type ArchiveOrganisationMutation,
} from "../src/data/organisation-lifecycle";
import {
  parseUserId,
  parseOrganisationId,
  type UserId,
  type OrganisationId,
} from "../src/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_180_000_000;

describe("organisation onboarding lifecycle", () => {
  it("archives an ownerless legacy organisation under explicit support-admin authority", async () => {
    const db = createMigratedDatabase();
    const organisationId = parseOrganisationId("organisation_ownerless_legacy");
    const supportAdminId = parseUserId(
      "user_ce8b309d-b2e6-539e-bf44-af44375437f1",
    );
    if (!organisationId.ok || !supportAdminId.ok)
      throw new Error("test identity invalid");
    await db.batch([
      db
        .prepare(
          `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
         VALUES (?, 'Ownerless legacy', 'beta', ?, 'active')`,
        )
        .bind(organisationId.value, NOW),
      db
        .prepare(
          `INSERT INTO app_user (
           user_id, issuer, subject, email, display_name,
           email_verified, created_at, last_authenticated_at
         ) VALUES (?, 'https://accounts.google.com', 'support-admin',
                   'support@example.com', 'Support Admin', 1, ?, ?)`,
        )
        .bind(supportAdminId.value, NOW, NOW),
      db
        .prepare(
          `INSERT INTO organisation_onboarding (
           organisation_id, environment, lifecycle, capability_profile,
           configuration_version, projection_revision, activation_receipt_id,
           activated_at, updated_at
         ) VALUES (?, 'production', 'active', 'read_and_propose', 1, 1,
                   'activation_legacy', ?, ?)`,
        )
        .bind(organisationId.value, NOW, NOW),
    ]);
    const placement = await ensureInitialOrganisationPlacement({
      db,
      organisationId: organisationId.value,
      environment: "production",
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    if (!placement.ok) throw new Error(placement.error.code);
    const mutationIdentity = newControlMutationIdentity({
      portalSubjectHash: "support-admin-subject-hash",
      causationId: "legacy-cutover",
      now: NOW + 1,
    });
    const archived = await archiveOrganisation({
      identityDatabase: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisationId.value,
      ),
      actorUserId: supportAdminId.value,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "legacy-cutover-0001",
          requestHash: "legacy-cutover-request",
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: supportAdminId.value,
          organisationScope: organisationId.value,
          route: `/v1/control/operator/organisations/${organisationId.value}/actions`,
          operation: "organisation.archive.legacy_cutover",
        },
        identity: mutationIdentity,
      },
      authority: {
        kind: "support_admin",
        subjectHash: mutationIdentity.portalSubjectHash,
        reasonCode: "legacy_cutover",
      },
      reasonCode: "legacy_cutover",
      now: NOW + 1,
    });

    expect(archived).toMatchObject({
      ok: true,
      value: { organisationId: organisationId.value },
    });
    await expect(
      readRow(db, "organisation_archive_tombstone", organisationId.value),
    ).resolves.toMatchObject({
      archive_authority_kind: "support_admin",
      archive_authority_subject_hash: "support-admin-subject-hash",
      archival_reason: "legacy_cutover",
    });
    await expect(
      readRow(db, "organisation", organisationId.value),
    ).resolves.toMatchObject({
      status: "deleted",
    });
  });

  it("archives canonical state and writes cleanup, audit, event, and idempotency evidence atomically", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "archive-owner",
        email: "archive@example.com",
        displayName: "Archive Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Archive Merchant",
      environment: "production",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const mutationIdentity = newControlMutationIdentity({
      portalSubjectHash: "archive-subject-hash",
      causationId: "archive-request",
      now: NOW + 1,
    });
    const archived = await archiveOrganisation({
      identityDatabase: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      actorUserId: owner.userId,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "archive-key-0001",
          requestHash: "archive-request-hash",
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisation.organisationId,
          route: `/v1/control/organisations/${organisation.organisationId}/archive`,
          operation: "organisation.archive",
        },
        identity: mutationIdentity,
      },
      authority: { kind: "organisation_owner" },
      reasonCode: "merchant_archived",
      now: NOW + 1,
    });

    expect(archived).toMatchObject({
      ok: true,
      value: {
        organisationId: organisation.organisationId,
        environment: "production",
        configurationVersion: 2,
        projectionRevision: 2,
        receiptId: mutationIdentity.receiptId,
      },
    });
    await expect(
      readRow(db, "organisation_onboarding", organisation.organisationId),
    ).resolves.toMatchObject({
      lifecycle: "archived",
      configuration_version: 2,
      projection_revision: 2,
      archived_at: NOW + 1,
    });
    await expect(
      readRow(db, "organisation_archive_cleanup", organisation.organisationId),
    ).resolves.toMatchObject({
      environment: "production",
      archive_receipt_id: mutationIdentity.receiptId,
      status: "pending_provider_cleanup",
    });
    await expect(
      countRows(db, "onboarding_audit_event", organisation.organisationId),
    ).resolves.toBe(2);
    await expect(
      countRows(db, "onboarding_event", organisation.organisationId),
    ).resolves.toBe(4);
    await expect(
      countRows(db, "control_mutation_receipt", owner.userId),
    ).resolves.toBe(2);

    const restoreIdentity = newControlMutationIdentity({
      portalSubjectHash: "archive-subject-hash",
      causationId: "restore-request",
      now: NOW + 2,
    });
    const restored = await restoreOrganisation({
      directory: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      actorUserId: owner.userId,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "restore-key-0001",
          requestHash: "restore-request-hash",
          expectedConfigurationVersion: 2,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisation.organisationId,
          route: `/v1/control/organisations/${organisation.organisationId}/restore`,
          operation: "organisation.restore",
        },
        identity: restoreIdentity,
      },
      now: NOW + 2,
    });
    expect(restored).toMatchObject({
      ok: true,
      value: {
        organisationId: organisation.organisationId,
        configurationVersion: 3,
        projectionRevision: 3,
        receiptId: restoreIdentity.receiptId,
      },
    });
    await expect(
      readRow(db, "organisation_onboarding", organisation.organisationId),
    ).resolves.toMatchObject({
      lifecycle: "configuring",
      configuration_version: 3,
      projection_revision: 3,
      archived_at: null,
      purge_after: null,
    });
    await expect(
      readRow(db, "organisation_archive_cleanup", organisation.organisationId),
    ).resolves.toBeNull();
    await expect(
      countRows(db, "onboarding_audit_event", organisation.organisationId),
    ).resolves.toBe(3);
    await expect(
      countRows(db, "onboarding_event", organisation.organisationId),
    ).resolves.toBe(5);
    await expect(
      countRows(db, "control_mutation_receipt", owner.userId),
    ).resolves.toBe(3);
  });

  it("renames an organisation and deletes it after archival", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "lifecycle-owner",
        email: "lifecycle@example.com",
        displayName: "Lifecycle Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Original organisation",
      environment: "production",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const renamed = await renameOrganisation({
      directory: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      actorUserId: owner.userId,
      name: "Renamed organisation",
      mutation: lifecycleMutation(
        owner.userId,
        organisation.organisationId,
        "organisation.rename",
        1,
        NOW + 1,
      ),
      now: NOW + 1,
    });
    expect(renamed).toMatchObject({
      ok: true,
      value: { configurationVersion: 2 },
    });
    await expect(
      readRow(db, "organisation", organisation.organisationId),
    ).resolves.toMatchObject({ name: "Renamed organisation" });

    const archived = await archiveOrganisation({
      identityDatabase: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      actorUserId: owner.userId,
      mutation: lifecycleMutation(
        owner.userId,
        organisation.organisationId,
        "organisation.archive",
        2,
        NOW + 2,
      ),
      authority: { kind: "organisation_owner" },
      reasonCode: "merchant_archived",
      now: NOW + 2,
    });
    expect(archived).toMatchObject({
      ok: true,
      value: { configurationVersion: 3 },
    });

    const deleted = await deleteArchivedOrganisation({
      directory: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      actorUserId: owner.userId,
      mutation: lifecycleMutation(
        owner.userId,
        organisation.organisationId,
        "organisation.delete",
        3,
        NOW + 3,
      ),
      now: NOW + 3,
    });
    expect(deleted).toMatchObject({
      ok: true,
      value: { configurationVersion: 4 },
    });
    await expect(
      readRow(db, "organisation", organisation.organisationId),
    ).resolves.toMatchObject({
      name: "Deleted organisation",
      status: "deleted",
    });
    await expect(
      readRow(db, "organisation_onboarding", organisation.organisationId),
    ).resolves.toMatchObject({ lifecycle: "archived", purge_after: NOW + 3 });
    await expect(
      countMemberships(db, organisation.organisationId),
    ).resolves.toBe(0);
  });
});

function lifecycleMutation(
  userId: UserId,
  organisationId: OrganisationId,
  operation: string,
  expectedConfigurationVersion: number,
  now: number,
): ArchiveOrganisationMutation {
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey: `${operation}-${now}`,
      requestHash: `${operation}-request-${now}`,
      expectedConfigurationVersion,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}`,
      operation,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "lifecycle-subject-hash",
      causationId: `${operation}-${now}`,
      now,
    }),
  };
}

async function readRow(
  db: SingleDatabase,
  table:
    | "organisation"
    | "organisation_onboarding"
    | "organisation_archive_cleanup"
    | "organisation_archive_tombstone",
  organisationId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(`SELECT * FROM ${table} WHERE organisation_id = ?`)
    .bind(organisationId)
    .first<Record<string, unknown>>();
}

async function countRows(
  db: SingleDatabase,
  table:
    "onboarding_audit_event" | "onboarding_event" | "control_mutation_receipt",
  identity: string,
): Promise<number> {
  const column =
    table === "control_mutation_receipt" ? "user_id" : "organisation_id";
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(identity)
    .first<{ readonly count: unknown }>();
  return typeof row?.count === "number" ? row.count : 0;
}

async function countMemberships(
  db: SingleDatabase,
  organisationId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM service_role_grant WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ readonly count: unknown }>();
  return typeof row?.count === "number" ? row.count : 0;
}
