// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import {
  singleDatabase,
  type GlobalDatabase,
  type SingleDatabase,
} from "@purin-labs/kernel/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  hashOpaqueSecret,
  upsertUser,
  type OrganisationBootstrap,
} from "@purin-labs/tenancy/data/control-plane";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import {
  inspectOrganisationHarnessHistory,
  listOnboardingReconciliationOrganisationIds,
  readOrganisationHarnessErasureReceipts,
  reconcileOrganisationOnboarding,
  reconcileAdmittedOrganisationArchiveCleanup,
} from "../src/data/onboarding-reconciliation";
import { ARCHIVE_CLEANUP_PARTS } from "../src/archive-cleanup-parts";
import type { SessionDO } from "../src/actors/agent-session";
import type { OrganisationDO } from "../src/actors/organisation";
import type {
  ActorActivationRequest,
  ActorActivationResult,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import type {
  HarnessHistoryErasureRequest,
  OrganisationArchiveCleanupRequest,
} from "@purin-labs/actor-runtime/actors/organisation-archive-cleanup";
import { AdmittedOrganisationArchiveCleanup } from "@purin-labs/actor-runtime/actors/organisation-archive-cleanup";
import type { ConnectorDO } from "../src/actors/connector";
import {
  activateActorRegistryEntry,
  reserveActor,
  listOrganisationActorRegistryEntries,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { parseSessionId } from "@purin-labs/kernel/ids";
import type { HarnessHistoryErasure } from "@purin-labs/agent/actors/agent-session-harness-authority";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { ActorRegistryEntry } from "@purin-labs/actor-runtime/actors/actor-registry";
import { createAuthorizingProviderAttempt } from "@purin-labs/connections/data/provider-attempt";
import {
  archiveOrganisation,
  type ArchivedOrganisation,
} from "@purin-labs/tenancy/data/organisation-lifecycle";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import type { VariantBy } from "@purin-labs/type-utils";
import type { OrganisationPlacementBindings } from "@purin-labs/tenancy/organisation-execution-scope";
import type { OrganisationPlacement } from "@purin-labs/tenancy/placement";
import {
  createMigratedDatabase,
  requireActorExecutionAdmission,
  requireActorRegistryAdmission,
} from "./sqlite-d1";
import {
  createSplitTopology,
  onboardSplitOrganisation,
} from "./split-topology";
import "./provide-organisation-lifecycle-parts";

const NOW = 1_784_390_000_000;

describe("onboarding reconciliation", () => {
  it("builds a read-only organisation NF9 history inventory with reachability filtering", async () => {
    const db = createMigratedDatabase();
    const organisation = await createArchivedHarnessOrganisation(db, {
      subject: "nf9-inventory-owner",
      email: "nf9-inventory@example.com",
      organisationName: "NF9 Inventory Merchant",
      now: NOW,
    });
    const entry = await reserveSessionRegistryEntry(
      db,
      organisation.organisation.organisationId,
      "session_nf9_inventory",
      NOW + 2,
    );
    const namespace = new TestSessionNamespace();
    const candidate = `harness-checkpoints/${encodeURIComponent(organisation.organisation.organisationId)}/session_nf9_inventory/checkpoint.bin`;
    const retained = "harness-artifacts/shared-retained.bin";
    namespace.add(
      entry.physicalObjectName,
      new TestSessionActor({
        references: [candidate, retained],
      }),
    );
    const before = await db
      .prepare("SELECT COUNT(*) AS count FROM organisation_harness_erasure")
      .first<{ readonly count: number }>();
    const inventory = await inspectOrganisationHarnessHistory({
      db,
      directory: db,
      sessionNamespace: namespace.binding(),
      organisationId: organisation.organisation.organisationId,
      inspectedAt: NOW + 3,
    });
    expect(inventory).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "organisation_harness_history_inventory.v1",
        organisationId: organisation.organisation.organisationId,
        sessions: [
          {
            registryId: entry.registryId,
            sessionId: "session_nf9_inventory",
            candidateKeys: [candidate],
          },
        ],
        candidateObjectKeys: [candidate],
        retainedObjectKeys: [retained],
      },
    });
    const after = await db
      .prepare("SELECT COUNT(*) AS count FROM organisation_harness_erasure")
      .first<{ readonly count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("records every subject and expires an abandoned provider attempt once", async () => {
    const db = createMigratedDatabase();
    const archive = new TestAttachmentArchive();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "reconciliation-owner",
        email: "reconciliation@example.com",
        displayName: "Reconciliation Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Reconciliation Merchant",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const attempt = await createAuthorizingProviderAttempt({
      db,
      organisationId: organisation.organisationId,
      provider: "slack",
      userId: owner.userId,
      existingIntegrationAccountId: null,
      purpose: "connect",
      portalSubjectHash: "reconciliation-subject-hash",
      stateHash: await hashOpaqueSecret("reconciliation-state"),
      nonceHash: await hashOpaqueSecret("reconciliation-nonce"),
      pkceVerifier: null,
      providerContext: JSON.stringify({ provider: "slack" }),
      returnPath: `/portal/${organisation.organisationId}`,
      expiresAt: NOW + 10,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "reconciliation-start-0001",
          requestHash: "reconciliation-start-request",
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisation.organisationId,
          route: `/v1/control/organisations/${organisation.organisationId}/providers/slack/start`,
          operation: "provider.attempt.start",
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "reconciliation-subject-hash",
          causationId: "reconciliation-start",
          now: NOW + 1,
        }),
      },
      now: NOW + 1,
    });
    if (!attempt.ok) {
      throw new Error(attempt.error.code);
    }

    await expect(
      listOnboardingReconciliationOrganisationIds(db),
    ).resolves.toEqual([organisation.organisationId]);
    const reconciled = await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: testSessionNamespace(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: NOW + 11,
    });
    expect(reconciled).toMatchObject({
      ok: true,
      value: {
        organisationId: organisation.organisationId,
        repairCount: 1,
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "completed",
            subject: "open_attempts",
            repairCount: 1,
          }),
        ]),
      },
    });
    const canonical = await db
      .prepare(
        `SELECT lifecycle FROM provider_connection_attempt WHERE attempt_id = ?`,
      )
      .bind(attempt.value.attempt.attemptId)
      .first<{ readonly lifecycle: unknown }>();
    expect(canonical?.lifecycle).toBe("expired");
    // Only the subject that repaired something leaves a run record.
    const runs = await db
      .prepare(
        `SELECT subject_kind AS subject, lifecycle, repair_count AS repairCount
       FROM onboarding_reconciliation_run WHERE organisation_id = ?`,
      )
      .bind(organisation.organisationId)
      .all();
    expect(runs.results).toEqual([
      { subject: "open_attempts", lifecycle: "completed", repairCount: 1 },
    ]);
    const expiredEvents = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM onboarding_event
       WHERE organisation_id = ? AND event_type = 'provider_attempt_expired'`,
      )
      .bind(organisation.organisationId)
      .first<{ readonly count: unknown }>();
    expect(expiredEvents?.count).toBe(1);
    const authorizationState = await db
      .prepare(
        `SELECT invalidation_reason AS invalidationReason
       FROM provider_authorization_state WHERE attempt_id = ?`,
      )
      .bind(attempt.value.attempt.attemptId)
      .first<{
        readonly invalidationReason: unknown;
      }>();
    expect(authorizationState?.invalidationReason).toBe("expired");
    const expiryAudits = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM onboarding_audit_event
       WHERE organisation_id = ? AND operation = 'provider.attempt.expire'`,
      )
      .bind(organisation.organisationId)
      .first<{ readonly count: unknown }>();
    expect(expiryAudits?.count).toBe(1);
  });

  it("revokes an archived organisation and completes its purge tombstone", async () => {
    const db = createMigratedDatabase();
    const archive = new TestAttachmentArchive();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "purge-owner",
        email: "purge@example.com",
        displayName: "Purge Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Purge Merchant",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const archivedAt = NOW + 1;
    const archived = await archiveOrganisation({
      identityDatabase: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      actorUserId: owner.userId,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "purge-archive-0001",
          requestHash: "purge-archive-request",
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisation.organisationId,
          route: `/v1/control/organisations/${organisation.organisationId}/archive`,
          operation: "organisation.archive",
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "purge-subject-hash",
          causationId: "purge-archive",
          now: archivedAt,
        }),
      },
      authority: { kind: "organisation_owner" },
      reasonCode: "merchant_archived",
      now: archivedAt,
    });
    if (!archived.ok) {
      throw new Error(archived.error.code);
    }
    archive.seed(
      `attachments/${organisation.organisationId}/slack/T_fixture/F_fixture/1`,
    );
    archive.seed("attachments/organisation_other/slack/T_fixture/F_fixture/1");
    await seedCredentialErasureRows(db, organisation.organisationId);
    await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: testSessionNamespace(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: archivedAt + 1,
    });
    const purged = await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: testSessionNamespace(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: archived.value.purgeAfter + 1,
    });
    expect(purged).toMatchObject({
      ok: true,
      value: {
        organisationId: organisation.organisationId,
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "completed",
            subject: "archived_organisation",
          }),
        ]),
      },
    });
    const cleanup = await db
      .prepare(
        `SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?`,
      )
      .bind(organisation.organisationId)
      .first<{ readonly status: unknown }>();
    expect(cleanup?.status).toBe("purged");
    const tombstone = await db
      .prepare(
        `SELECT archive_authority_subject_hash AS ownerSubjectHash, purged_at AS purgedAt
       FROM organisation_archive_tombstone WHERE organisation_id = ?`,
      )
      .bind(organisation.organisationId)
      .first<{
        readonly ownerSubjectHash: unknown;
        readonly purgedAt: unknown;
      }>();
    expect(tombstone).toMatchObject({
      ownerSubjectHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      purgedAt: archived.value.purgeAfter + 1,
    });
    const membership = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM service_role_grant WHERE organisation_id = ?`,
      )
      .bind(organisation.organisationId)
      .first<{ readonly count: unknown }>();
    expect(membership?.count).toBe(0);
    const organisationRow = await db
      .prepare(
        `SELECT name, status FROM organisation WHERE organisation_id = ?`,
      )
      .bind(organisation.organisationId)
      .first<{
        readonly name: unknown;
        readonly status: unknown;
      }>();
    expect(organisationRow).toEqual({
      name: "Archived organisation",
      status: "purged",
    });
    await expect(
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM vault_secret WHERE organisation_id = ?)
               AS vaultSecrets,
             (SELECT COUNT(*) FROM credential_ref WHERE organisation_id = ?)
               AS credentialRefs,
             (SELECT COUNT(*) FROM credential_revocation_operation
              WHERE organisation_id = ?) AS revocationOperations,
             (SELECT COUNT(*) FROM credential_access_denial
              WHERE organisation_id = ?) AS accessDenials`,
        )
        .bind(
          organisation.organisationId,
          organisation.organisationId,
          organisation.organisationId,
          organisation.organisationId,
        )
        .first(),
    ).resolves.toEqual({
      vaultSecrets: 0,
      credentialRefs: 0,
      revocationOperations: 1,
      accessDenials: 1,
    });
    expect(archive.keys()).toEqual([
      "attachments/organisation_other/slack/T_fixture/F_fixture/1",
    ]);
  });

  it("retries partial NF9 erasure and preserves a retained shared key", async () => {
    const db = createMigratedDatabase();
    const archive = new TestAttachmentArchive();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "nf9-erasure-owner",
        email: "nf9-erasure@example.com",
        displayName: "NF9 Erasure Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "NF9 Erasure Merchant",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const archived = await archiveOrganisation({
      identityDatabase: db,
      execution: await requireOrganisationExecutionScope(
        {
          DB: db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        organisation.organisationId,
      ),
      actorUserId: owner.userId,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "nf9-erasure-archive-0001",
          requestHash: "nf9-erasure-archive-request",
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: owner.userId,
          organisationScope: organisation.organisationId,
          route: `/v1/control/organisations/${organisation.organisationId}/archive`,
          operation: "organisation.archive",
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "nf9-erasure-subject-hash",
          causationId: "nf9-erasure-archive",
          now: NOW + 1,
        }),
      },
      authority: { kind: "organisation_owner" },
      reasonCode: "merchant_archived",
      now: NOW + 1,
    });
    if (!archived.ok) {
      throw new Error(archived.error.code);
    }
    const sharedKey = "harness-artifacts/shared-retained.bin";
    const crossOrganisationKey = "attachments/organisation_other/shared.bin";
    const deleteKey = `harness-checkpoints/${encodeURIComponent(organisation.organisationId)}/session_nf9_first/delete-me.bin`;
    archive.seed(sharedKey);
    archive.seed(crossOrganisationKey);
    archive.seed(deleteKey);
    await db
      .prepare(
        `INSERT INTO organisation_harness_erasure (
         organisation_id, status, failure_code, session_count, candidate_count,
         deleted_count, started_at, updated_at, completed_at
       ) VALUES (?, 'inventorying', NULL, 0, 0, 0, ?, ?, NULL)`,
      )
      .bind(organisation.organisationId, NOW, NOW)
      .run();
    const firstSession = await reserveSessionRegistryEntry(
      db,
      organisation.organisationId,
      "session_nf9_first",
      100,
    );
    const secondSession = await reserveSessionRegistryEntry(
      db,
      organisation.organisationId,
      "session_nf9_second",
      101,
    );
    const namespace = new TestSessionNamespace();
    namespace.add(
      firstSession.physicalObjectName,
      new TestSessionActor({
        references: [sharedKey, crossOrganisationKey, deleteKey],
      }),
    );
    namespace.add(
      secondSession.physicalObjectName,
      new TestSessionActor({
        references: [sharedKey, crossOrganisationKey],
        failEraseOnce: true,
      }),
    );

    await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: namespace.binding(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: NOW + 2,
    });

    const first = await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: namespace.binding(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: archived.value.purgeAfter + 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "failed",
            subject: "archived_organisation",
          }),
        ]),
      },
    });
    expect(namespace.actor(firstSession.physicalObjectName).eraseCalls).toBe(1);
    expect(namespace.actor(secondSession.physicalObjectName).eraseCalls).toBe(
      1,
    );
    expect(archive.keys()).toEqual([
      crossOrganisationKey,
      sharedKey,
      deleteKey,
    ]);

    const second = await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: namespace.binding(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: archived.value.purgeAfter + 2,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "completed",
            subject: "archived_organisation",
          }),
        ]),
      },
    });
    expect(namespace.actor(firstSession.physicalObjectName).eraseCalls).toBe(1);
    expect(namespace.actor(secondSession.physicalObjectName).eraseCalls).toBe(
      2,
    );
    expect(archive.keys()).toEqual([crossOrganisationKey, sharedKey]);
    await expect(
      db
        .prepare(
          `SELECT status FROM organisation_harness_erasure WHERE organisation_id = ?`,
        )
        .bind(organisation.organisationId)
        .first<{ readonly status: unknown }>(),
    ).resolves.toEqual({
      status: "completed",
    });
    await expect(
      db
        .prepare(
          `SELECT status FROM organisation_harness_erasure_object
       WHERE organisation_id = ? AND object_key = ?`,
        )
        .bind(organisation.organisationId, deleteKey)
        .first<{ readonly status: unknown }>(),
    ).resolves.toEqual({
      status: "deleted",
    });
    await expect(
      db
        .prepare(
          `SELECT status FROM organisation_harness_erasure_object
       WHERE organisation_id = ? AND object_key = ?`,
        )
        .bind(organisation.organisationId, sharedKey)
        .first<{ readonly status: unknown }>(),
    ).resolves.toEqual({
      status: "retained",
    });
    await expect(
      db
        .prepare(
          `SELECT status FROM organisation_harness_erasure_object
       WHERE organisation_id = ? AND object_key = ?`,
        )
        .bind(organisation.organisationId, crossOrganisationKey)
        .first<{ readonly status: unknown }>(),
    ).resolves.toEqual({
      status: "retained",
    });

    await expect(
      db
        .prepare(
          `SELECT purged_at AS purgedAt FROM organisation_archive_tombstone WHERE organisation_id = ?`,
        )
        .bind(organisation.organisationId)
        .first<{ readonly purgedAt: unknown }>(),
    ).resolves.toEqual({
      purgedAt: archived.value.purgeAfter + 2,
    });
    const receipts = await readOrganisationHarnessErasureReceipts(
      db,
      organisation.organisationId,
      archived.value.purgeAfter + 3,
    );
    if (!receipts.ok) {
      throw new Error(receipts.error.code);
    }
    expect(receipts.value).toMatchObject({
      schemaVersion: "organisation_harness_erasure_receipts.v1",
      organisationId: organisation.organisationId,
      status: "completed",
      purgeAfter: archived.value.purgeAfter,
      objectAccounting: {
        candidateCount: 3,
        deletedCount: 1,
        retainedCount: 2,
      },
    });
    expect(receipts.value.completedAt).not.toBeNull();
    expect(receipts.value.registryFingerprint).not.toBeNull();
    expect(receipts.value.sessionReceipts).toHaveLength(2);
    expect(
      receipts.value.sessionReceipts.map((receipt) => receipt.sessionId),
    ).toEqual(["session_nf9_first", "session_nf9_second"]);
    for (const receipt of receipts.value.sessionReceipts) {
      expect(receipt.receiptId).toBe(`harness_erasure_${receipt.registryId}`);
      expect(receipt.status).toBe("erased");
      expect(receipt.erasedAt).not.toBeNull();
      expect(receipt.failureCode).toBeNull();
    }
    expect(receipts.value.sessionReceipts[0]?.erasureCounts).toEqual({
      historyRows: 3,
      checkpointRows: 0,
      leaseRows: 0,
      deliveryRows: 0,
    });
    expect(receipts.value.sessionReceipts[1]?.erasureCounts).toEqual({
      historyRows: 2,
      checkpointRows: 0,
      leaseRows: 0,
      deliveryRows: 0,
    });
    const replayedReceipts = await readOrganisationHarnessErasureReceipts(
      db,
      organisation.organisationId,
      archived.value.purgeAfter + 4,
    );
    expect(replayedReceipts).toEqual(receipts);
  });

  it("reports the retention fence before the purge window elapses", async () => {
    const db = createMigratedDatabase();
    const organisation = await createArchivedHarnessOrganisation(db, {
      subject: "nf9-fence-owner",
      email: "nf9-fence@example.com",
      organisationName: "NF9 Fence Merchant",
      now: NOW,
    });
    const receipts = await readOrganisationHarnessErasureReceipts(
      db,
      organisation.organisation.organisationId,
      NOW + 5,
    );
    if (!receipts.ok) {
      throw new Error(receipts.error.code);
    }
    expect(receipts.value).toMatchObject({
      status: "retention_window_open",
      purgeAfter: organisation.archived.purgeAfter,
      registryFingerprint: null,
      completedAt: null,
      sessionReceipts: [],
      objectAccounting: {
        candidateCount: 0,
        deletedCount: 0,
        retainedCount: 0,
      },
    });
    expect(organisation.archived.purgeAfter).toBeGreaterThan(NOW + 5);
  });

  it("blocks purge while a reserved session registry authority exists", async () => {
    const db = createMigratedDatabase();
    const archive = new TestAttachmentArchive();
    const { organisation, archived } = await createArchivedHarnessOrganisation(
      db,
      {
        subject: "nf9-reserved-owner",
        email: "nf9-reserved@example.com",
        organisationName: "NF9 Reserved Merchant",
        now: NOW,
      },
    );
    await reserveUnactivatedSessionRegistryEntry(
      db,
      organisation.organisationId,
      "session_nf9_reserved",
      NOW + 2,
    );
    await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: testSessionNamespace(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: NOW + 3,
    });

    const reconciled = await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: testSessionNamespace(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: archived.purgeAfter + 1,
    });
    expect(reconciled).toMatchObject({
      ok: true,
      value: {
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "failed",
            subject: "archived_organisation",
          }),
        ]),
      },
    });
    await expect(
      db
        .prepare(
          `SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?`,
        )
        .bind(organisation.organisationId)
        .first<{ readonly status: unknown }>(),
    ).resolves.toEqual({
      status: "pending_purge",
    });
    await expect(
      db
        .prepare(
          `SELECT status, failure_code AS failureCode
       FROM organisation_harness_erasure WHERE organisation_id = ?`,
        )
        .bind(organisation.organisationId)
        .first<{
          readonly status: unknown;
          readonly failureCode: unknown;
        }>(),
    ).resolves.toEqual({
      status: "failed",
      failureCode: "organisation_harness_erasure_registry_not_erasable",
    });
  });

  it("blocks completion when a session registry entry is added during erasure", async () => {
    const db = createMigratedDatabase();
    const archive = new TestAttachmentArchive();
    const { organisation, archived } = await createArchivedHarnessOrganisation(
      db,
      {
        subject: "nf9-drift-owner",
        email: "nf9-drift@example.com",
        organisationName: "NF9 Drift Merchant",
        now: NOW,
      },
    );
    const deleteKey = `harness-checkpoints/${encodeURIComponent(organisation.organisationId)}/session_nf9_drift/delete-me.bin`;
    archive.seed(deleteKey);
    const firstSession = await reserveSessionRegistryEntry(
      db,
      organisation.organisationId,
      "session_nf9_drift",
      NOW + 2,
    );
    const namespace = new TestSessionNamespace();
    let driftAdded = false;
    namespace.add(
      firstSession.physicalObjectName,
      new TestSessionActor({
        references: [deleteKey],
        onErase: async () => {
          if (driftAdded) {
            return;
          }
          driftAdded = true;
          await reserveSessionRegistryEntry(
            db,
            organisation.organisationId,
            "session_nf9_drift_added",
            NOW + 3,
          );
        },
      }),
    );
    await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: namespace.binding(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: NOW + 4,
    });

    const first = await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: namespace.binding(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: archived.purgeAfter + 1,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "failed",
            subject: "archived_organisation",
          }),
        ]),
      },
    });
    expect(archive.keys()).toEqual([deleteKey]);

    const entries = await listOrganisationActorRegistryEntries({
      db,
      organisationId: organisation.organisationId,
    });
    if (!entries.ok) {
      throw new Error(entries.error.code);
    }
    const added = entries.value.find(
      (entry) =>
        entry.identity.objectKind === "session" &&
        entry.identity.logicalObjectId === "session_nf9_drift_added",
    );
    if (added === undefined || added.lifecycleStatus !== "active") {
      throw new Error("drifted session registry entry missing");
    }
    namespace.add(
      added.physicalObjectName,
      new TestSessionActor({
        references: [],
      }),
    );

    const second = await reconcileOnboardingFixture({
      db,
      archive: archive.binding(),
      sessionNamespace: namespace.binding(),
      connectorNamespace: testConnectorNamespace(),
      organisationId: organisation.organisationId,
      now: archived.purgeAfter + 2,
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "completed",
            subject: "archived_organisation",
          }),
        ]),
      },
    });
    expect(archive.keys()).toEqual([]);
  });

  // The deployed topology: the erasure ledger and the Actor registry are in the
  // Organisation's regional database, the relocation journal in the global one.
  it("purges an archived organisation on the split topology, keeps a journal's export and revokes the Slack installation that no other Organisation uses", async () => {
    const topology = createSplitTopology();
    const regional = topology.regional.db;
    const archive = new TestAttachmentArchive();
    const organisation = await onboardSplitOrganisation(topology, NOW);
    const organisationId = organisation.organisationId;
    const archived = await archiveOrganisation({
      identityDatabase: topology.env.DB,
      execution: organisation.scope,
      actorUserId: organisation.owner.userId,
      mutation: {
        boundary: {
          kind: "configuration_versioned",
          idempotencyKey: "split-purge-archive-0001",
          requestHash: "split-purge-archive-request",
          expectedConfigurationVersion: 1,
        },
        scope: {
          userId: organisation.owner.userId,
          organisationScope: organisationId,
          route: `/v1/control/organisations/${organisationId}/archive`,
          operation: "organisation.archive",
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: "split-purge-subject-hash",
          causationId: "split-purge-archive",
          now: NOW + 1,
        }),
      },
      authority: { kind: "organisation_owner" },
      reasonCode: "merchant_archived",
      now: NOW + 1,
    });
    if (!archived.ok) throw new Error(archived.error.code);
    const entry = await reserveSessionRegistryEntry(
      regional,
      organisationId,
      "session_split_purge",
      NOW + 2,
      organisation.scope.placement,
    );
    const prefix = `harness-checkpoints/${encodeURIComponent(organisationId)}/session_split_purge`;
    const erased = `${prefix}/erased.bin`;
    const held = `${prefix}/held.bin`;
    topology.global.sqlite.exec("PRAGMA foreign_keys = OFF");
    await topology.env.DB.prepare(
      `INSERT INTO state_object_relocation_item (
         relocation_id, object_kind, logical_object_id, source_registry_id,
         target_registry_id, export_id, export_key, export_organisation_id,
         export_payload_digest_b64, export_created_at, status, updated_at
       ) VALUES ('relocation_split_purge', 'session', 'session_split_purge', ?,
         NULL, 'export_split_purge', ?, ?, 'digest', ?, 'exported', ?)`,
    )
      .bind(entry.registryId, held, organisationId, NOW, NOW)
      .run();
    archive.seed(erased);
    archive.seed(held);
    const namespace = new TestSessionNamespace();
    namespace.add(
      entry.physicalObjectName,
      new TestSessionActor({ references: [erased, held] }),
    );
    // This Organisation installed a Slack workspace. No other Organisation
    // has an active connection there, so the purge revokes the installation
    // and erases its token with the Vault (Refactor 15).
    const sharedHandle = "vault:split-purge:slack:installation";
    await topology.env.DB.prepare(
      `INSERT INTO slack_installation (
         installation_id, environment, app_id, workspace_id,
         credential_organisation_id, bot_token_ref, install_model, scopes_json,
         lifecycle, installed_at, updated_at, disabled_at, revoked_at
       ) VALUES ('slack_installation_split_purge', 'production', 'A_SPLIT',
         'T_SPLIT', ?, ?, 'unlisted', '[]', 'active', ?, ?, NULL, NULL)`,
    )
      .bind(organisationId, sharedHandle, NOW, NOW)
      .run();
    const vaultSecret = regional.prepare(
      `INSERT INTO vault_secret (
         organisation_id, vault_handle, key_version, algorithm, nonce_b64,
         ciphertext_b64, created_at, rotated_at, revoked_at
       ) VALUES (?, ?, 'v1', 'AES-GCM-256', 'nonce', 'ciphertext', ?, NULL, NULL)`,
    );
    await regional.batch([
      vaultSecret.bind(organisationId, sharedHandle, NOW),
      vaultSecret.bind(organisationId, "vault:split-purge:airtable", NOW),
    ]);

    expect(
      await inspectOrganisationHarnessHistory({
        db: regional,
        directory: topology.env.DB,
        sessionNamespace: namespace.binding(),
        organisationId,
        inspectedAt: NOW + 3,
      }),
    ).toMatchObject({
      ok: true,
      value: { candidateObjectKeys: [erased], retainedObjectKeys: [held] },
    });

    const fixture = {
      env: topology.env,
      db: regional,
      archive: archive.binding(),
      sessionNamespace: namespace.binding(),
      connectorNamespace: testConnectorNamespace(),
      organisationId,
    };
    await reconcileOnboardingFixture({ ...fixture, now: NOW + 4 });
    const purged = await reconcileOnboardingFixture({
      ...fixture,
      now: archived.value.purgeAfter + 1,
    });
    expect(purged).toMatchObject({
      ok: true,
      value: {
        runs: expect.arrayContaining([
          expect.objectContaining({
            kind: "completed",
            subject: "archived_organisation",
          }),
        ]),
      },
    });
    expect(
      await regional
        .prepare(
          "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
        )
        .bind(organisationId)
        .first(),
    ).toEqual({ status: "purged" });
    expect(archive.keys()).toEqual([held]);
    expect(
      await regional
        .prepare(
          "SELECT vault_handle AS handle, revoked_at AS revokedAt FROM vault_secret WHERE organisation_id = ?",
        )
        .bind(organisationId)
        .all(),
    ).toMatchObject({ results: [] });
    expect(
      await topology.env.DB.prepare(
        "SELECT lifecycle FROM slack_installation WHERE installation_id = 'slack_installation_split_purge'",
      ).first("lifecycle"),
    ).toBe("revoked");
    expect(
      await topology.env.DB.prepare(
        "SELECT name, status FROM organisation WHERE organisation_id = ?",
      )
        .bind(organisationId)
        .first(),
    ).toEqual({ name: "Archived organisation", status: "purged" });
  });
});

class TestAttachmentArchive {
  private readonly objectKeys = new Set<string>();

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  seed(key: string): void {
    this.objectKeys.add(key);
  }

  keys(): string[] {
    return [...this.objectKeys].sort();
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const objects = this.keys()
      .filter(keyMatchesPrefix.bind(null, prefix))
      .map(testR2Object);
    return {
      objects,
      truncated: false,
      delimitedPrefixes: [],
    } as unknown as R2Objects;
  }

  async delete(keys: string | string[]): Promise<void> {
    const values = Array.isArray(keys) ? keys : [keys];

    for (const key of values) {
      this.objectKeys.delete(key);
    }
  }
}

async function createArchivedHarnessOrganisation(
  db: SingleDatabase,
  input: {
    readonly subject: string;
    readonly email: string;
    readonly organisationName: string;
    readonly now: number;
  },
): Promise<{
  readonly organisation: OrganisationBootstrap;
  readonly archived: ArchivedOrganisation;
}> {
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: input.subject,
      email: input.email,
      displayName: input.organisationName,
      emailVerified: true,
    },
    now: input.now,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: input.organisationName,
    environment: "development",
    mutation: organisationBootstrapMutation(owner, input.now),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: input.now,
  });
  const archived = await archiveOrganisation({
    identityDatabase: db,
    execution: await requireOrganisationExecutionScope(
      {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      organisation.organisationId,
    ),
    actorUserId: owner.userId,
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: `${input.subject}-archive`,
        requestHash: `${input.subject}-archive-request`,
        expectedConfigurationVersion: 1,
      },
      scope: {
        userId: owner.userId,
        organisationScope: organisation.organisationId,
        route: `/v1/control/organisations/${organisation.organisationId}/archive`,
        operation: "organisation.archive",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: `${input.subject}-portal`,
        causationId: `${input.subject}-archive`,
        now: input.now + 1,
      }),
    },
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: input.now + 1,
  });
  if (!archived.ok) {
    throw new Error(archived.error.code);
  }
  return { organisation, archived: archived.value };
}

async function seedCredentialErasureRows(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  const handle = "vault:purge:airtable";
  await db.batch([
    db
      .prepare(
        `INSERT INTO vault_secret (
         organisation_id, vault_handle, key_version, algorithm, nonce_b64,
         ciphertext_b64, created_at, rotated_at, revoked_at
       ) VALUES (
         ?, ?, 'v1', 'AES-GCM-256', 'nonce', 'ciphertext', ?, NULL, NULL
       )`,
      )
      .bind(organisationId, handle, NOW),
    db
      .prepare(
        `INSERT INTO credential_ref (
         organisation_id, provider, name, vault_handle, host_pattern,
         inject_as, created_at, revoked_at
       ) VALUES (?, 'airtable', 'oauth', ?, 'api.airtable.com',
         '{"kind":"header","header":"authorization","scheme":"Bearer"}',
         ?, NULL)`,
      )
      .bind(organisationId, handle, NOW),
    db
      .prepare(
        `INSERT INTO credential_revocation_operation (
         revocation_id, organisation_id, vault_handle, state,
         credential_generation_count, provider_connection_count,
         integration_account_count, provider_webhook_count,
         credential_ref_count, vault_secret_count,
         policy_version, restriction_version, target_consumer_count,
         acknowledged_consumer_count, pending_consumer_count,
         retry_count, restriction_latency_ms,
         started_at, committed_at, policy_activated_at
       ) VALUES (
         'revocation_purge', ?, ?, 'committed', 1, 1, 1, 0, 1, 1,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
       )`,
      )
      .bind(organisationId, handle, NOW, NOW),
    db
      .prepare(
        `INSERT INTO credential_access_denial (
         denial_id, organisation_id, purpose, reason_code, vault_handle, occurred_at
       ) VALUES (
         'denial_purge', ?, 'provider_action', 'credential_revoked', ?, ?
       )`,
      )
      .bind(organisationId, handle, NOW),
  ]);
}

async function reserveSessionRegistryEntry(
  db: SingleDatabase,
  organisationId: OrganisationId,
  sessionIdRaw: string,
  now: number,
  placement: OrganisationPlacement = TEST_INITIAL_ORGANISATION_PLACEMENT,
): Promise<VariantBy<ActorRegistryEntry, "lifecycleStatus", "active">> {
  const sessionId = parseSessionId(sessionIdRaw);
  if (!sessionId.ok) {
    throw new Error(sessionId.error.code);
  }
  const reserved = await reserveActor({
    db,
    identity: {
      objectKind: "session",
      organisationId,
      logicalObjectId: sessionId.value,
    },
    admission: await requireActorExecutionAdmission(
      db,
      organisationId,
      placement,
    ),
    schemaVersion: 1,
    now,
  });
  if (!reserved.ok) {
    throw new Error(reserved.error.code);
  }
  const activated = await activateActorRegistryEntry({
    db,
    admission: await requireActorRegistryAdmission(
      db,
      reserved.value.registryId,
    ),
    registryId: reserved.value.registryId,
    activationToken: reserved.value.activationToken,
    stateVersion: 1,
    now: now + 1,
  });
  if (!activated.ok) {
    throw new Error(activated.error.code);
  }
  const entries = await listOrganisationActorRegistryEntries({
    db,
    organisationId,
  });
  if (!entries.ok) {
    throw new Error(entries.error.code);
  }
  const entry = entries.value.find(
    (candidate) => candidate.registryId === reserved.value.registryId,
  );
  if (entry === undefined || entry.lifecycleStatus !== "active") {
    throw new Error("session registry entry missing");
  }
  return entry;
}

async function reserveUnactivatedSessionRegistryEntry(
  db: SingleDatabase,
  organisationId: OrganisationId,
  sessionIdRaw: string,
  now: number,
): Promise<VariantBy<ActorRegistryEntry, "lifecycleStatus", "reserved">> {
  const sessionId = parseSessionId(sessionIdRaw);
  if (!sessionId.ok) {
    throw new Error(sessionId.error.code);
  }
  const reserved = await reserveActor({
    db,
    identity: {
      objectKind: "session",
      organisationId,
      logicalObjectId: sessionId.value,
    },
    admission: await requireActorExecutionAdmission(
      db,
      organisationId,
      TEST_INITIAL_ORGANISATION_PLACEMENT,
    ),
    schemaVersion: 1,
    now,
  });
  if (!reserved.ok || reserved.value.lifecycleStatus !== "reserved") {
    throw new Error(
      reserved.ok
        ? "reserved session unexpectedly activated"
        : reserved.error.code,
    );
  }
  return reserved.value;
}

class TestSessionNamespace {
  private readonly actors = new Map<string, TestSessionActor>();

  add(name: string, actor: TestSessionActor): void {
    this.actors.set(name, actor);
  }

  actor(name: string): TestSessionActor {
    const actor = this.actors.get(name);
    if (actor === undefined) {
      throw new Error("test session actor missing");
    }
    return actor;
  }

  idFromName(name: string): string {
    return name;
  }

  get(name: string): TestSessionActor {
    return this.actor(name);
  }

  binding(): DurableObjectNamespace<SessionDO> {
    return this as unknown as DurableObjectNamespace<SessionDO>;
  }
}

class TestSessionActor {
  readonly references: readonly string[];
  readonly failEraseOnce: boolean;
  readonly onErase: (() => Promise<void>) | undefined;
  eraseCalls = 0;
  private failed = false;

  constructor(input: {
    readonly references: readonly string[];
    readonly failEraseOnce?: boolean;
    readonly onErase?: () => Promise<void>;
  }) {
    this.references = input.references;
    this.failEraseOnce = input.failEraseOnce ?? false;
    this.onErase = input.onErase;
  }

  inspectHarnessHistoryReferences(_input: {
    readonly requestingOrganisationId: OrganisationId;
  }): Promise<
    Result<readonly string[], { readonly code: "harness_history_invalid" }>
  > {
    return Promise.resolve({ ok: true, value: this.references });
  }

  quiescePortalChatCleanup(): Promise<Result<null, never>> {
    return Promise.resolve({ ok: true, value: null });
  }

  eraseHarnessHistory(
    _input: HarnessHistoryErasureRequest,
  ): Promise<
    Result<HarnessHistoryErasure, { readonly code: "harness_history_invalid" }>
  > {
    this.eraseCalls += 1;
    if (this.failEraseOnce && !this.failed) {
      this.failed = true;
      return Promise.resolve({
        ok: false,
        error: { code: "harness_history_invalid" },
      });
    }
    return this.finishErase();
  }

  private async finishErase(): Promise<
    Result<HarnessHistoryErasure, { readonly code: "harness_history_invalid" }>
  > {
    if (this.onErase !== undefined) {
      await this.onErase();
    }
    return {
      ok: true,
      value: {
        historyRows: this.references.length,
        checkpointRows: 0,
        leaseRows: 0,
        deliveryRows: 0,
        objectKeys: this.references,
      },
    };
  }
}

type ReconciliationFixture = Omit<
  Parameters<typeof reconcileOrganisationOnboarding>[0],
  "organisationNamespace" | "env"
> & {
  // The bindings of a split topology. Without them one combined database is
  // both the global directory and the Organisation's own database.
  readonly env?: OrganisationPlacementBindings;
};

function reconcileOnboardingFixture(input: ReconciliationFixture) {
  const env = input.env ?? {
    // One combined database: the directory and the Organisation's database.
    DB: singleDatabase(input.db),
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  };
  return reconcileOrganisationOnboarding({
    env,
    db: input.db,
    archive: input.archive,
    sessionNamespace: input.sessionNamespace,
    connectorNamespace: input.connectorNamespace,
    organisationId: input.organisationId,
    now: input.now,
    organisationNamespace: new ArchiveOrganisationFixture(
      input,
      env.DB,
    ).binding(),
  });
}

class ArchiveOrganisationFixture {
  constructor(
    private readonly input: ReconciliationFixture,
    private readonly directory: GlobalDatabase,
  ) {}

  idFromName(name: string): string {
    return name;
  }
  get(_name: string): ArchiveOrganisationFixture {
    return this;
  }

  activate(input: ActorActivationRequest): Promise<ActorActivationResult> {
    return Promise.resolve({
      ok: true,
      value: {
        kind: "activated",
        registryId: input.registryId,
        stateVersion: 1,
      },
    });
  }

  async reconcileArchiveCleanup(request: OrganisationArchiveCleanupRequest) {
    const value = await reconcileAdmittedOrganisationArchiveCleanup({
      // No voice zone in this fixture.
      env: {} as never,
      parts: ARCHIVE_CLEANUP_PARTS,
      db: this.input.db,
      directory: this.directory,
      archive: this.input.archive,
      sessionNamespace: this.input.sessionNamespace,
      connectorNamespace: this.input.connectorNamespace,
      request: AdmittedOrganisationArchiveCleanup.fromStored({
        kind: "admitted",
        request,
      }),
    });
    return { ok: true as const, value };
  }

  binding(): DurableObjectNamespace<OrganisationDO> {
    return this as unknown as DurableObjectNamespace<OrganisationDO>;
  }
}

function testSessionNamespace(): DurableObjectNamespace<SessionDO> {
  return {} as DurableObjectNamespace<SessionDO>;
}

/**
 * Organisation erasure reaches Connector Actors to empty WhatsApp storage before the
 * D1 rows go. These fixtures never reach that path, so an unbound namespace is
 * enough to satisfy the signature.
 */
function testConnectorNamespace(): DurableObjectNamespace<ConnectorDO> {
  return {} as DurableObjectNamespace<ConnectorDO>;
}

function keyMatchesPrefix(prefix: string, key: string): boolean {
  return key.startsWith(prefix);
}

function testR2Object(key: string): R2Object {
  return { key } as unknown as R2Object;
}
