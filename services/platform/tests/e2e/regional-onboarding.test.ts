import { organisationDatabase as organisationHandle } from "@purin-labs/kernel/database-handles";
import {
  parseModelApiKey,
  storeOrganisationModelCredential,
} from "@purin-labs/authority/credential-vault/index";
import { resolveOrganisationModelRouteForSelection } from "../../src/models/route";
import { readOrganisationCodexConnectionAtScope } from "../../src/models/codex-connection";
import {
  seedRegionalCanvas,
  verifyRegionalCanvas,
  continueRecoveredCanvas,
} from "./regional-canvas-support";
import {
  startActorRestore,
  resumeActorRestore,
} from "@purin-labs/actor-runtime/actors/actor-restore";
import { prepareActorRestoreManifest } from "@purin-labs/actor-runtime/actors/actor-restore-manifest";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import {
  bakeryRunSnapshotPrefix,
  savedBakeryRunArchiveKeys,
} from "../../src/commerce/bakery/saved-runs";
import { sha256Hex } from "@purin-labs/std";
import {
  workspaceRevisionArchiveKeys,
  verifyWorkspaceRevisionReceipt,
} from "../../src/workspace-revision-store";
import { ensureOrganisationDefaultWorkspace } from "../../src/data/organisation-workspace";
import {
  beginRegionalProviderRetry,
  finishRegionalProviderRetry,
} from "./regional-provider-retry-support";
import {
  regionalHarnessJourney,
  verifyConversationWriteFence,
} from "./regional-harness-support";
import {
  exerciseRegionalExecution,
  exerciseRegionalVaultRotation,
  regionalCallback,
  regionalQueue,
} from "./regional-execution-support";
import { resolveWhatsAppOrganisationCredential } from "../../src/whatsapp/credential";
import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  bootstrapOrganisation,
  upsertUser,
} from "@purin-labs/tenancy/data/control-plane";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import {
  startActorRelocation,
  abandonActorRelocation,
  inspectActorRelocation,
  resumeActorRelocation,
  readRetainedActorRelocationExports,
  type ActorRelocationId,
  type RetainedActorRelocationExport,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import {
  loadActorExport,
  restoreReferencedR2Objects,
  type ActorExportR2Object,
} from "@purin-labs/actor-runtime/actors/actor-export";
import { publishOrganisationPlacementMove } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  readOrganisationPlacementMove,
  readPlacementByEpoch,
  parseOrganisationPlacementMoveTarget,
} from "@purin-labs/tenancy/data/organisation-placement";
import { parseInitialOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import {
  actorStubForRegistryEntry,
  requireActiveSessionActor,
  requireActiveOrganisationActorAtPlacement,
} from "@purin-labs/actor-runtime/actors/actor-router";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { parseSessionId } from "@purin-labs/kernel/ids";
import {
  listPlacementActorRegistryEntries,
  beginActorExport,
  retireActorRegistryEntry,
  type ActorRegistryEntry,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { OrganisationDO } from "../../src/actors/organisation";
import {
  regionalCopyTables,
  countRegionalOrganisationRows,
} from "@purin-labs/actor-runtime/data/organisation-regional-copy";
import type { ActorImportRequest } from "@purin-labs/actor-runtime/actors/actor-export";
import type { OrganisationId } from "@purin-labs/kernel/ids";

it(
  "onboards isolated regional organisations and recovers their Actors after eviction",
  regionalOnboardingJourney,
  100_000,
);

async function regionalOnboardingJourney({ task }: TestContext): Promise<void> {
  if (!env.ORGANISATION_DB_WNAM || !env.ORGANISATION_DB_APAC)
    throw new Error("Regional bindings missing");
  const west = await onboardRegionalOrganisation("wnam");
  const east = await onboardRegionalOrganisation("apac");
  expect(west.organisationId).not.toBe(east.organisationId);
  for (const [database, organisationId] of [
    [env.ORGANISATION_DB_WNAM, west.organisationId],
    [env.ORGANISATION_DB_APAC, east.organisationId],
  ] as const) {
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS total FROM workspace_revision_receipt WHERE organisation_id = ?",
        )
        .bind(organisationId)
        .first(),
    ).toEqual({ total: 1 });
  }
  Object.assign(task.meta, { workspaceReadyBeforeFirstTurn: true });
  expect(
    await env.DB.prepare(
      "SELECT organisation_id FROM organisation_placement WHERE status = 'active' ORDER BY organisation_id",
    ).all(),
  ).toMatchObject({
    results: expect.arrayContaining([
      { organisation_id: west.organisationId },
      { organisation_id: east.organisationId },
    ]),
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM organisation_placement WHERE status = 'active'",
    ).first(),
  ).toEqual({ total: 2 });
  expect(
    await env.ORGANISATION_DB_WNAM.prepare(
      "SELECT organisation_id FROM organisation",
    ).all(),
  ).toMatchObject({ results: [{ organisation_id: west.organisationId }] });
  expect(
    await env.ORGANISATION_DB_APAC.prepare(
      "SELECT organisation_id FROM organisation",
    ).all(),
  ).toMatchObject({ results: [{ organisation_id: east.organisationId }] });
  expect(
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_object_registry'",
    ).all(),
  ).toMatchObject({ results: [] });
  for (const scope of [west, east]) {
    const actor = await requireActiveOrganisationActorAtPlacement({
      env,
      organisationId: scope.organisationId,
      placement: scope.placement,
      now: Date.now(),
    });
    expect(
      (
        await actor.readCaseContextDiscoveryConfiguration({
          organisationId: scope.organisationId,
        })
      ).ok,
    ).toBe(true);
    const other = scope.organisationId === west.organisationId ? east : west;
    expect(
      await actor.getOrganisation({
        requestingOrganisationId: other.organisationId,
      }),
    ).toMatchObject({ ok: false, error: { code: "organisation_mismatch" } });
    await runInDurableObject(actor, scheduleRecovery);
    await evictDurableObject(actor);
    expect(await runDurableObjectAlarm(actor)).toBe(true);
    expect(
      (
        await actor.readCaseContextDiscoveryConfiguration({
          organisationId: scope.organisationId,
        })
      ).ok,
    ).toBe(true);
    expect(
      await scope.database
        .prepare(
          "SELECT organisation_id, placement_cell_id FROM durable_object_registry WHERE organisation_id = ?",
        )
        .bind(scope.organisationId)
        .all(),
    ).toMatchObject({
      results: [
        {
          organisation_id: scope.organisationId,
          placement_cell_id: scope.placement.placementCellId,
        },
      ],
    });
  }
  await regionalHarnessJourney(west, east, "initial");
  await regionalHarnessJourney(east, west, "initial");
  await verifyConversationWriteFence(west, "active");
  const workspaceReceipt = await ensureOrganisationDefaultWorkspace({
    scope: west,
    archive: env.ARCHIVE,
    now: Date.now(),
  });
  if (!workspaceReceipt.ok) throw new Error(workspaceReceipt.error.code);
  expect(
    await verifyWorkspaceRevisionReceipt(
      west,
      west.organisationId,
      workspaceReceipt.value,
    ),
  ).toEqual({ ok: true, value: workspaceReceipt.value });
  const providerAccount = await exerciseRegionalExecution(west);
  await west.database
    .prepare(
      "UPDATE workspace_ai_budget SET max_tokens = 123456, applied_revision = 0 WHERE organisation_id = ?",
    )
    .bind(west.organisationId)
    .run();
  const people: D1PreparedStatement[] = [];
  for (let index = 0; index < 1_245; index += 1) {
    people.push(
      west.database
        .prepare(
          "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
        )
        .bind(
          west.organisationId,
          `person_copy_${index}`,
          `Transferred person ${index}`,
        ),
    );
  }
  await west.database.batch(people);
  await west.database
    .prepare(
      "INSERT INTO organisation_activation_attempt (activation_attempt_id, organisation_id, readiness_version, readiness_hash, status, started_at, updated_at, completed_at) VALUES ('activation_regional_copy', ?, 1, 'regional-copy-history', 'completed', 1, 2, 2)",
    )
    .bind(west.organisationId)
    .run();
  await west.database
    .prepare(
      "INSERT INTO organisation_activation_step (activation_attempt_id, step, status, receipt, completed_at) VALUES ('activation_regional_copy', 'placement', 'completed', ?, 2)",
    )
    .bind(JSON.stringify({ copied: true }))
    .run();
  await seedWorkspaceHistory(west);
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "regional-apac",
    locationHint: "apac",
  });
  if (!target.ok) throw new Error(target.error.path);
  const schemaProbe = await west.database
    .prepare(
      "SELECT registry_id AS registryId, schema_version AS schemaVersion FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active' LIMIT 1",
    )
    .bind(west.organisationId)
    .first<{ registryId: string; schemaVersion: number }>();
  if (schemaProbe === null)
    throw new Error("Missing schema acceptance Session");
  await west.database
    .prepare(
      "UPDATE durable_object_registry SET schema_version = ? WHERE registry_id = ?",
    )
    .bind(schemaProbe.schemaVersion + 1, schemaProbe.registryId)
    .run();
  try {
    expect(
      await startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "target_schema_older_than_export" },
    });
    expect(await west.isActive()).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM state_object_relocation WHERE organisation_id = ?",
      )
        .bind(west.organisationId)
        .first("count"),
    ).toBe(0);
  } finally {
    await west.database
      .prepare(
        "UPDATE durable_object_registry SET schema_version = ? WHERE registry_id = ?",
      )
      .bind(schemaProbe.schemaVersion, schemaProbe.registryId)
      .run();
  }
  const originalCapacitySession = env.ORGANISATION_DB_APAC.withSession.bind(
    env.ORGANISATION_DB_APAC,
  );
  Object.defineProperty(env.ORGANISATION_DB_APAC, "withSession", {
    configurable: true,
    value: fullCapacitySession.bind(null, originalCapacitySession),
  });
  try {
    expect(
      await startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "regional_capacity_insufficient",
        targetDatabaseBytes: 10_000_000_000,
      },
    });
    expect(await west.isActive()).toBe(true);
  } finally {
    Object.defineProperty(env.ORGANISATION_DB_APAC, "withSession", {
      configurable: true,
      value: originalCapacitySession,
    });
  }
  const sourceActor = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: west.organisationId,
    placement: west.placement,
    now: Date.now(),
  });
  const bakerySnapshot = parseRunSnapshot({
    name: "Regional saved run",
    document: {
      schemaVersion: 3,
      kind: "bakery-workcell-experiment",
      input: {},
      evidence: null,
      presentation: { workcell: { x: 134, y: 284 } },
    },
  });
  if (bakerySnapshot === null) throw new Error("Invalid bakery fixture");
  const bakeryKey =
    bakeryRunSnapshotPrefix(west.organisationId) +
    (await sha256Hex(bakerySnapshot.content));
  const bakeryMetadata = {
    name: bakerySnapshot.name,
    kind: bakerySnapshot.kind,
  };
  await env.ARCHIVE.put(bakeryKey, "corrupt saved run", {
    customMetadata: bakeryMetadata,
  });
  try {
    expect(
      await startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "export_read_failed",
        detail: "saved_bakery_run_archive_invalid",
      },
    });
    expect(await west.isActive()).toBe(true);
  } finally {
    await env.ARCHIVE.put(bakeryKey, bakerySnapshot.content, {
      customMetadata: bakeryMetadata,
      httpMetadata: { contentType: "application/json" },
    });
  }
  const workspaceObjects = await workspaceRevisionArchiveKeys(
    west.database,
    env.ARCHIVE,
    west.organisationId,
  );
  if (!workspaceObjects.ok) throw new Error(workspaceObjects.error.code);
  expect(workspaceObjects.value.length).toBeGreaterThanOrEqual(6);
  const workspaceKey = workspaceObjects.value[0];
  if (workspaceKey === undefined) throw new Error("Missing workspace archive");
  const workspaceObject = await env.ARCHIVE.get(workspaceKey);
  if (workspaceObject === null) throw new Error("Missing workspace object");
  const workspaceBytes = await workspaceObject.arrayBuffer();
  await env.ARCHIVE.put(workspaceKey, "corrupt workspace manifest");
  try {
    expect(
      await startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "export_read_failed",
        detail: "workspace_revision_object_corrupt",
      },
    });
    expect(await west.isActive()).toBe(true);
  } finally {
    await env.ARCHIVE.put(workspaceKey, workspaceBytes);
  }
  const globalUserSchema = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'app_user'",
  ).first<{ sql: string }>();
  if (globalUserSchema === null) throw new Error("Missing global user schema");
  await west.database.prepare(globalUserSchema.sql).run();
  await west.database
    .prepare(
      "INSERT INTO app_user VALUES ('user_global_retained', 'fixture', 'retained', 'retained@example.com', 'Global user', 1, 1, 1)",
    )
    .run();
  const sessionEntry = await west.database
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active' LIMIT 1",
    )
    .bind(west.organisationId)
    .first<{ name: string }>();
  if (sessionEntry === null) throw new Error("Missing regional Session");
  const references = await env.SESSION.getByName(
    sessionEntry.name,
  ).inspectHarnessHistoryReferences({
    requestingOrganisationId: west.organisationId,
  });
  if (!references.ok) throw new Error(references.error.code);
  const archiveKey = references.value[0];
  if (archiveKey === undefined)
    throw new Error("Missing regional Session archive reference");
  const archive = await env.ARCHIVE.get(archiveKey);
  if (archive === null) throw new Error("Missing regional Session archive");
  const archiveBytes = await archive.arrayBuffer();
  await env.ARCHIVE.delete(archiveKey);
  try {
    expect(
      await startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "referenced_r2_missing", key: archiveKey },
    });
    expect(await west.isActive()).toBe(true);
  } finally {
    await env.ARCHIVE.put(archiveKey, archiveBytes, {
      httpMetadata: archive.httpMetadata,
      customMetadata: archive.customMetadata,
    });
  }
  await env.ORGANISATION_DB_APAC.prepare(
    "ALTER TABLE workspace_ai_budget RENAME COLUMN max_tokens TO incompatible_budget",
  ).run();
  try {
    await expect(
      startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).rejects.toThrow("regional_schema_mismatch:workspace_ai_budget");
    expect(await west.isActive()).toBe(true);
  } finally {
    await env.ORGANISATION_DB_APAC.prepare(
      "ALTER TABLE workspace_ai_budget RENAME COLUMN incompatible_budget TO max_tokens",
    ).run();
  }
  await west.database
    .prepare(
      `CREATE TABLE regional_preflight_reference (
      organisation_id TEXT NOT NULL, reference_id TEXT NOT NULL,
      PRIMARY KEY (organisation_id, reference_id),
      FOREIGN KEY (organisation_id) REFERENCES organisation(organisation_id))`,
    )
    .run();
  try {
    await west.database
      .prepare(
        "INSERT INTO regional_preflight_reference VALUES (?, 'retained-source-reference')",
      )
      .bind(west.organisationId)
      .run();
    await expect(
      startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).rejects.toThrow("regional_schema_tables_mismatch");
    expect(await west.isActive()).toBe(true);
    await env.ORGANISATION_DB_APAC.prepare(
      `CREATE TABLE regional_preflight_reference (
        organisation_id TEXT NOT NULL, reference_id TEXT NOT NULL,
        PRIMARY KEY (organisation_id, reference_id))`,
    ).run();
    await expect(
      startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).rejects.toThrow(
      "regional_foreign_keys_mismatch:regional_preflight_reference",
    );
    expect(await west.isActive()).toBe(true);
    expect(
      await west.database
        .prepare(
          "SELECT reference_id FROM regional_preflight_reference WHERE organisation_id = ?",
        )
        .bind(west.organisationId)
        .first(),
    ).toEqual({ reference_id: "retained-source-reference" });
  } finally {
    await west.database
      .prepare("DROP TABLE regional_preflight_reference")
      .run();
    await env.ORGANISATION_DB_APAC.prepare(
      "DROP TABLE IF EXISTS regional_preflight_reference",
    ).run();
  }
  await env.DB.prepare(
    "CREATE TRIGGER interrupt_relocation_reservation BEFORE INSERT ON state_object_relocation BEGIN SELECT RAISE(ABORT, 'relocation_reservation_interrupted'); END",
  ).run();
  try {
    await expect(
      startActorRelocation({
        env,
        organisationId: west.organisationId,
        target: target.value,
        now: Date.now(),
      }),
    ).rejects.toThrow("relocation_reservation_interrupted");
    expect(await west.isActive()).toBe(true);
  } finally {
    await env.DB.prepare("DROP TRIGGER interrupt_relocation_reservation").run();
  }
  const started = await startActorRelocation({
    env,
    organisationId: west.organisationId,
    target: target.value,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  expect(started.value.preflight.rowCount).toBeGreaterThan(1_245);
  expect(started.value.preflight.tableCount).toBeGreaterThan(100);
  expect(started.value.preflight.actorBytes).toBeGreaterThan(0);
  expect(started.value.preflight.actorCount).toBeGreaterThan(2);
  const lateSessionId = parseSessionId(
    "session_created_after_regional_preflight",
  );
  if (!lateSessionId.ok) throw new Error("Invalid late session identity");
  const lateSession = await requireActiveSessionActor({
    env,
    organisationId: west.organisationId,
    sessionId: lateSessionId.value,
    now: Date.now(),
  });
  await runInDurableObject(
    lateSession,
    writeLateSessionState.bind(null, "accepted before source freeze"),
  );
  const cleanupProvider = await beginRegionalProviderRetry(
    west,
    providerAccount,
    started.value.relocationId,
  );
  await interruptRelocationJournal(started.value.relocationId, {
    table: "state_object_relocation",
    condition: "NEW.status = 'frozen' AND OLD.status = 'reserved'",
  });
  await env.DB.prepare(
    `CREATE TRIGGER interrupt_final_actor_inventory BEFORE INSERT ON state_object_relocation_item
      WHEN NEW.logical_object_id = 'session_created_after_regional_preflight'
      BEGIN SELECT RAISE(ABORT, 'regional_inventory_interrupted'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("regional_inventory_interrupted");
  expect(await west.isActive()).toBe(false);
  await verifyConversationWriteFence(west, "frozen");
  expect(
    await verifyWorkspaceRevisionReceipt(
      west,
      west.organisationId,
      workspaceReceipt.value,
    ),
  ).toEqual({ ok: false, error: { code: "organisation_placement_conflict" } });
  Object.assign(task.meta, { workspaceReceiptFencedAtRead: true });
  Object.assign(task.meta, { conversationWritesFencedAtCommit: true });
  await env.DB.prepare("DROP TRIGGER interrupt_final_actor_inventory").run();
  await interruptRelocationJournal(started.value.relocationId, {
    table: "state_object_relocation",
    condition:
      "NEW.source_quiesced_at IS NOT NULL AND OLD.source_quiesced_at IS NULL",
  });
  await env.ORGANISATION_DB_APAC.prepare(
    "CREATE TRIGGER interrupt_regional_copy BEFORE INSERT ON service_role_grant BEGIN SELECT RAISE(ABORT, 'regional_copy_interrupted'); END",
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("regional_copy_interrupted");
  expect(await west.isActive()).toBe(false);
  await verifyClosedCaseAdmission(west);
  Object.assign(task.meta, { closedSourceCaseAdmission: true });
  await regionalCallback(503);
  await regionalQueue(west, true);
  expect(
    await sourceActor.readCaseContextDiscoveryConfiguration({
      organisationId: west.organisationId,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_conflict" },
  });
  await env.ORGANISATION_DB_APAC.prepare(
    "DROP TRIGGER interrupt_regional_copy",
  ).run();
  await env.ORGANISATION_DB_APAC.prepare(
    "UPDATE person SET display_name = 'Corrupted transfer' WHERE organisation_id = ? AND person_id = 'person_copy_0'",
  )
    .bind(west.organisationId)
    .run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("regional_copy_mismatch:person");
  expect(
    await env.DB.prepare(
      "SELECT status FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = 2",
    )
      .bind(west.organisationId)
      .first(),
  ).toEqual({ status: "reserved" });
  await env.ORGANISATION_DB_APAC.prepare(
    "UPDATE person SET display_name = 'Transferred person 0' WHERE organisation_id = ? AND person_id = 'person_copy_0'",
  )
    .bind(west.organisationId)
    .run();

  expect(
    await west.database
      .prepare(
        "SELECT COUNT(*) FROM person_authz_audit WHERE organisation_id = ?",
      )
      .bind(west.organisationId)
      .first("COUNT(*)"),
  ).toBe(0);
  await env.ORGANISATION_DB_APAC.prepare(
    `INSERT INTO person_authz_audit VALUES (?, 'unexpected_target_audit', 'person_copy_0',
      'grant', 'command', 'organisation_admin_token', 'unexpected_target_request', ?)`,
  )
    .bind(west.organisationId, Date.now())
    .run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("regional_copy_mismatch:person_authz_audit");
  await env.ORGANISATION_DB_APAC.prepare(
    "DELETE FROM person_authz_audit WHERE organisation_id = ? AND audit_id = 'unexpected_target_audit'",
  )
    .bind(west.organisationId)
    .run();
  await env.DB.prepare(
    `INSERT INTO state_object_relocation_copy
      (relocation_id, table_name, cursor_json, row_count, content_digest, status, verified_at)
      VALUES (?, 'person_authz_audit', '[]', 1, 'lost_source_row', 'copying', NULL)
      ON CONFLICT (relocation_id, table_name) DO UPDATE SET row_count = 1, content_digest = 'lost_source_row'`,
  )
    .bind(started.value.relocationId)
    .run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("D1_ERROR");
  await env.DB.prepare(
    "DELETE FROM state_object_relocation_copy WHERE relocation_id = ? AND table_name = 'person_authz_audit'",
  )
    .bind(started.value.relocationId)
    .run();

  await env.ORGANISATION_DB_APAC.prepare(
    "CREATE TRIGGER interrupt_regional_resume BEFORE UPDATE OF status ON organisation_placement WHEN NEW.status = 'active' AND OLD.status = 'reserved' BEGIN SELECT RAISE(ABORT, 'regional_resume_interrupted'); END",
  ).run();
  await runInDurableObject(
    sourceActor,
    armOrganisationBackupRecovery.bind(
      null,
      west.organisationId,
      east.organisationId,
    ),
  );
  for (const transition of [
    {
      table: "state_object_relocation",
      condition: "NEW.status = 'copying' AND OLD.status = 'frozen'",
    },
    {
      table: "state_object_relocation_item",
      condition: "NEW.status = 'exported' AND OLD.status = 'pending'",
    },
    {
      table: "state_object_relocation_item",
      condition: "NEW.status = 'imported' AND OLD.status = 'exported'",
    },
    {
      table: "state_object_relocation",
      condition:
        "NEW.data_verified_at IS NOT NULL AND OLD.data_verified_at IS NULL",
    },
    {
      table: "state_object_relocation",
      condition: "NEW.status = 'published' AND OLD.status <> 'published'",
    },
  ]) {
    await interruptRelocationJournal(started.value.relocationId, transition);
    expect(await west.isActive()).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT status FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = 2",
      )
        .bind(west.organisationId)
        .first(),
    ).toEqual({ status: "reserved" });
  }
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("regional_resume_interrupted");
  await env.ORGANISATION_DB_APAC.prepare(
    "DROP TRIGGER interrupt_regional_resume",
  ).run();
  for (const transition of [
    {
      table: "state_object_relocation_item",
      condition: "NEW.status = 'retired' AND OLD.status = 'imported'",
    },
    {
      table: "state_object_relocation",
      condition: "NEW.status = 'retained' AND OLD.status = 'published'",
    },
  ]) {
    await interruptRelocationJournal(started.value.relocationId, transition);
    expect(await west.isActive()).toBe(false);
  }
  const completed = await resumeActorRelocation({
    env,
    relocationId: started.value.relocationId,
    now: Date.now(),
  });
  if (!completed.ok) throw new Error(completed.error.code);
  expect(completed.value.status).toBe("retained");
  const moved = await OrganisationExecutionScope.resolve(
    env,
    west.organisationId,
  );
  if (!moved.ok) throw new Error(moved.error.code);
  expect(moved.value.placement.placementCellId).toBe("regional-apac");
  expect(moved.value.placement.placementEpoch).toBe(2);
  const relocatedLateSession = await requireActiveSessionActor({
    env,
    organisationId: west.organisationId,
    sessionId: lateSessionId.value,
    now: Date.now(),
  });
  await evictDurableObject(relocatedLateSession);
  expect(
    await runInDurableObject(relocatedLateSession, readLateSessionState),
  ).toBe("accepted before source freeze");
  await runInDurableObject(
    relocatedLateSession,
    writeLateSessionState.bind(null, "accepted after regional publication"),
  );
  const movedActor = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: west.organisationId,
    placement: moved.value.placement,
    now: Date.now(),
  });
  await recoverWorkspaceArchiveFromRelocation(
    moved.value,
    started.value.relocationId,
  );
  expect(
    (
      await movedActor.readCaseContextDiscoveryConfiguration({
        organisationId: west.organisationId,
      })
    ).ok,
  ).toBe(true);
  await evictDurableObject(sourceActor);
  expect(
    await sourceActor.readCaseContextDiscoveryConfiguration({
      organisationId: west.organisationId,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_conflict" },
  });
  expect(
    await moved.value.database
      .prepare(
        "SELECT COUNT(*) AS total FROM person WHERE organisation_id = ? AND person_id LIKE 'person_copy_%'",
      )
      .bind(west.organisationId)
      .first(),
  ).toEqual({ total: 1_245 });
  expect(
    await moved.value.database
      .prepare(
        "SELECT receipt FROM organisation_activation_step WHERE activation_attempt_id = 'activation_regional_copy'",
      )
      .first(),
  ).toEqual({ receipt: JSON.stringify({ copied: true }) });
  expect(
    await movedActor.getOrganisation({
      requestingOrganisationId: west.organisationId,
    }),
  ).toMatchObject({ ok: true, value: { name: "Regional wnam" } });
  expect(
    await moved.value.database
      .prepare(
        "SELECT COUNT(*) AS total FROM workspace_revision WHERE organisation_id = ? AND workspace_id = 'workspace_regional_copy'",
      )
      .bind(west.organisationId)
      .first(),
  ).toEqual({ total: 3 });
  expect(
    await moved.value.database
      .prepare(
        "SELECT max_tokens, applied_revision FROM workspace_ai_budget WHERE organisation_id = ?",
      )
      .bind(west.organisationId)
      .first(),
  ).toEqual({ max_tokens: 123456, applied_revision: 0 });
  await regionalCallback(200);
  await regionalQueue(moved.value, false);
  await exerciseRegionalVaultRotation();
  expect(
    await resolveWhatsAppOrganisationCredential({
      env,
      scope: moved.value,
      integrationAccountId: providerAccount,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true });
  expect(
    await resolveWhatsAppOrganisationCredential({
      env,
      scope: west,
      integrationAccountId: providerAccount,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: false });
  // The copy fixture deliberately retained a pending budget. End that fixture before inference.
  await moved.value.database
    .prepare(
      "UPDATE workspace_ai_budget SET applied_revision = revision WHERE organisation_id = ?",
    )
    .bind(west.organisationId)
    .run();
  await regionalHarnessJourney(moved.value, east, "relocated");
  expect(
    await east.database
      .prepare(
        "SELECT max_tokens FROM workspace_ai_budget WHERE organisation_id = ?",
      )
      .bind(east.organisationId)
      .first(),
  ).toEqual({ max_tokens: 500000 });
  expect(
    await env.DB.prepare(
      "SELECT source_quiesced_at, data_verified_at FROM state_object_relocation WHERE relocation_id = ?",
    )
      .bind(started.value.relocationId)
      .first(),
  ).toMatchObject({
    source_quiesced_at: expect.any(Number),
    data_verified_at: expect.any(Number),
  });
  await finishRegionalProviderRetry(moved.value, cleanupProvider);
  expect(await east.isActive()).toBe(true);
  expect(
    await env.ORGANISATION_DB_APAC.prepare("PRAGMA foreign_key_check").all(),
  ).toMatchObject({ results: [] });
  const retained = await resumeActorRelocation({
    env,
    relocationId: started.value.relocationId,
    now: Date.now(),
  });
  expect(retained).toMatchObject({ ok: true, value: { status: "retained" } });
  const returnTarget = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "regional-wnam",
    locationHint: "wnam",
  });
  if (!returnTarget.ok) throw new Error(returnTarget.error.path);
  expect(
    await startActorRelocation({
      env,
      organisationId: west.organisationId,
      target: returnTarget.value,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: false, error: { code: "relocation_conflict" } });
  expect(await moved.value.isActive()).toBe(true);
  expect(
    await west.database
      .prepare(
        "SELECT COUNT(*) AS total FROM person WHERE organisation_id = ? AND person_id LIKE 'person_copy_%'",
      )
      .bind(west.organisationId)
      .first(),
  ).toEqual({ total: 1_245 });
  const neighbor = await onboardRegionalOrganisation("wnam", "source-neighbor");
  const neighborPeople = await neighbor.database
    .prepare(
      "SELECT person_id, display_name FROM person WHERE organisation_id = ? ORDER BY person_id",
    )
    .bind(neighbor.organisationId)
    .all();
  expect(neighborPeople.results.length).toBeGreaterThan(0);
  const retainedExports = await env.DB.prepare(
    "SELECT export_key AS exportKey FROM state_object_relocation_item WHERE relocation_id = ?",
  )
    .bind(started.value.relocationId)
    .all<{ exportKey: string }>();
  expect(retainedExports.results.length).toBeGreaterThan(0);
  for (const item of retainedExports.results)
    expect(await env.ARCHIVE.head(item.exportKey)).not.toBeNull();
  expect(
    (await waiveRetentionRequest(started.value.relocationId, false, true))
      .status,
  ).toBe(404);
  expect(
    (await waiveRetentionRequest(started.value.relocationId, true, false))
      .status,
  ).toBe(422);
  expect(
    (await waiveRetentionRequest(started.value.relocationId, true, true))
      .status,
  ).toBe(202);
  const waiver = await env.DB.prepare(
    "SELECT retention_waived_at AS waivedAt, retain_until AS retainUntil FROM state_object_relocation WHERE relocation_id = ?",
  )
    .bind(started.value.relocationId)
    .first<{ waivedAt: number; retainUntil: number }>();
  expect(waiver?.waivedAt).toBeGreaterThan(0);
  expect(waiver?.retainUntil).toBeGreaterThan(Date.now());
  for (const transition of [
    {
      table: "state_object_relocation",
      condition: "NEW.status = 'cleaning' AND OLD.status = 'retained'",
    },
    {
      table: "state_object_relocation_item",
      condition:
        "NEW.source_cleaned_at IS NOT NULL AND OLD.source_cleaned_at IS NULL",
    },
  ]) {
    await interruptRelocationJournal(started.value.relocationId, transition);
    expect(await moved.value.isActive()).toBe(true);
  }
  await west.database
    .prepare(
      "CREATE TRIGGER interrupt_regional_cleanup BEFORE DELETE ON person WHEN OLD.person_id = 'person_copy_0' BEGIN SELECT RAISE(ABORT, 'regional_cleanup_interrupted'); END",
    )
    .run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("regional_cleanup_interrupted");
  expect(
    await env.DB.prepare(
      "SELECT status FROM state_object_relocation WHERE relocation_id = ?",
    )
      .bind(started.value.relocationId)
      .first(),
  ).toEqual({ status: "cleaning" });
  await west.database.prepare("DROP TRIGGER interrupt_regional_cleanup").run();
  await interruptRelocationJournal(started.value.relocationId, {
    table: "state_object_relocation",
    condition: "NEW.status = 'complete' AND OLD.status = 'cleaning'",
  });
  expect(
    await resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { status: "complete" } });
  expect(
    await west.database
      .prepare("SELECT COUNT(*) AS total FROM person WHERE organisation_id = ?")
      .bind(west.organisationId)
      .first(),
  ).toEqual({ total: 0 });
  expect(
    await west.database
      .prepare(
        "SELECT status FROM organisation_placement WHERE organisation_id = ?",
      )
      .bind(west.organisationId)
      .first(),
  ).toEqual({ status: "retired" });
  expect(await neighbor.isActive()).toBe(true);
  expect(await east.isActive()).toBe(true);
  expect(await moved.value.isActive()).toBe(true);
  expect(
    await west.database.prepare("PRAGMA foreign_key_check").all(),
  ).toMatchObject({ results: [] });
  expect(
    (
      await neighbor.database
        .prepare(
          "SELECT person_id, display_name FROM person WHERE organisation_id = ? ORDER BY person_id",
        )
        .bind(neighbor.organisationId)
        .all()
    ).results,
  ).toEqual(neighborPeople.results);
  for (const item of retainedExports.results)
    expect(await env.ARCHIVE.head(item.exportKey)).toBeNull();
  await regionalHarnessJourney(moved.value, east, "cleaned");
  const returnMove = await startActorRelocation({
    env,
    organisationId: west.organisationId,
    target: returnTarget.value,
    now: Date.now(),
  });
  if (!returnMove.ok) throw new Error(returnMove.error.code);
  expect(
    await resumeActorRelocation({
      env,
      relocationId: returnMove.value.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({
    ok: true,
    value: { status: "retained", targetPlacementEpoch: 3 },
  });
  const returned = await OrganisationExecutionScope.resolve(
    env,
    west.organisationId,
  );
  if (!returned.ok) throw new Error(returned.error.code);
  expect(returned.value.placement.placementEpoch).toBe(3);
  const returnedLateSession = await requireActiveSessionActor({
    env,
    organisationId: west.organisationId,
    sessionId: lateSessionId.value,
    now: Date.now(),
  });
  expect(
    await runInDurableObject(returnedLateSession, readLateSessionState),
  ).toBe("accepted after regional publication");
  expect(await west.isActive()).toBe(false);
  expect(await moved.value.isActive()).toBe(false);
  expect(await neighbor.isActive()).toBe(true);
  expect(
    await sourceActor.getOrganisation({
      requestingOrganisationId: west.organisationId,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await west.database
      .prepare(
        "SELECT user_id FROM app_user WHERE user_id = 'user_global_retained'",
      )
      .first(),
  ).toEqual({ user_id: "user_global_retained" });
  expect(
    await env.ORGANISATION_DB_APAC.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'app_user'",
    ).first(),
  ).toBeNull();
  Object.assign(task.meta, {
    regionalExecution: {
      emptyTargetContaminationRejected: true,
      inconsistentEmptyTableJournalRejected: true,
      lateActorTransferredAfterInterruptedCopy: true,
      interruptedFinalInventoryRecovered: true,
      preflightInventoryPersisted: true,
      newerSessionSchemaRejectedBeforeExport: true,
      incompatibleTargetRejectedBeforeFreeze: true,
      sourceOnlyTableRejectedBeforeFreeze: true,
      foreignKeyMismatchRejectedBeforeFreeze: true,
      missingSessionArchiveRejectedBeforeFreeze: true,
      corruptWorkspaceRejectedBeforeFreeze: true,
      workspaceBackupRestoredAfterOriginalLoss: true,
      organisationDataBackupRestoredAfterPartialFailure: true,
      globalUserRowRetainedInCombinedSource: true,
      unresolvedProviderIdentifiedBeforeFreeze: true,
      sevenDaySourceRetention: true,
      interruptedSourceCleanup: true,
      neighboringSourceOrganisationPreserved: true,
      freshMoveBackUsesNewEpoch: true,
      regionalHarnessToolTurns: 4,
      deploymentSchemaMismatchRejected: true,
      providerInFlightMoveBlocked: true,
      providerRetryOnTarget: true,
      duplicateProviderRetrySuppressed: true,
      atomicWriteRollback: true,
      signedProviderCallback: true,
      frozenCallbackRetry: true,
      queuedWorkRetry: true,
      relocatedCredential: true,
      staleCredentialRejected: true,
      globalSessionRevocation: true,
    },
    regionalOnboarding: {
      relocation: {
        beforePublicationInterruption: true,
        afterPublicationInterruption: true,
        staleSourceRejected: true,
        otherOrganisationUnaffected: true,
      },
      cells: [west.placement.placementCellId, east.placement.placementCellId],
      isolatedDatabases: true,
      bootstrapReplay: true,
      unavailableRegionResume: true,
      actorRecoveryAfterEviction: true,
      foreignOrganisationRejected: true,
    },
  });
}

async function scheduleRecovery(
  _actor: OrganisationDO,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.setAlarm(Date.now() + 60_000);
}

async function onboardRegionalOrganisation(
  region: "wnam" | "apac",
  identity: string = region,
): Promise<OrganisationExecutionScope> {
  const now = Date.now();
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `regional-${identity}`,
      email: `${identity}@example.test`,
      displayName: region,
      emailVerified: true,
    },
    now,
  });
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: `regional-${region}`,
    locationHint: region,
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const input = {
    env,
    owner,
    organisationName: `Regional ${region}`,
    environment: "development" as const,
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: owner.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned" as const,
        idempotencyKey: `regional-${identity}`,
        requestHash: `regional-${identity}`,
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: `regional-${identity}`,
        causationId: `regional-${identity}`,
        now,
      }),
    },
  };
  if (region === "apac") {
    const { ORGANISATION_DB_APAC, ...unavailable } = env;
    expect(ORGANISATION_DB_APAC).toBeDefined();
    const interrupted = await bootstrapOrganisation({
      ...input,
      env: unavailable,
    });
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: "organisation_cell_unavailable" },
    });
    if (!ORGANISATION_DB_APAC) throw new Error("Regional binding missing");
    await ORGANISATION_DB_APAC.prepare(
      "CREATE TRIGGER interrupt_regional_bootstrap BEFORE INSERT ON organisation_workspace BEGIN SELECT RAISE(ABORT, 'regional_bootstrap_interrupted'); END",
    ).run();
    await expect(bootstrapOrganisation(input)).rejects.toThrow(
      "regional_bootstrap_interrupted",
    );
    await ORGANISATION_DB_APAC.prepare(
      "DROP TRIGGER interrupt_regional_bootstrap",
    ).run();
    expect(
      await env.DB.prepare(
        "SELECT status FROM organisation_placement WHERE placement_cell_id = 'regional-apac'",
      ).all(),
    ).toMatchObject({ results: [{ status: "reserved" }] });
  }
  const created = await bootstrapOrganisation(input);
  if (!created.ok) throw new Error(created.error.code);
  const replay = await bootstrapOrganisation(input);
  if (!replay.ok) throw new Error(replay.error.code);
  expect(replay.value.organisationId).toBe(created.value.organisationId);
  await ensureCreatedOrganisationActor({
    env,
    organisationId: created.value.organisationId,
    now,
  });
  const scope = await OrganisationExecutionScope.resolve(
    env,
    created.value.organisationId,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  return scope.value;
}

async function seedWorkspaceHistory(
  scope: OrganisationExecutionScope,
): Promise<void> {
  let base: string | null = null;
  for (const revision of [
    `workspace_revision_${"f".repeat(64)}`,
    `workspace_revision_${"8".repeat(64)}`,
    `workspace_revision_${"0".repeat(64)}`,
  ]) {
    const manifest = JSON.stringify({
      schemaVersion: "workspace_revision_manifest.v1",
      organisationId: scope.organisationId,
      workspaceId: "workspace_regional_copy",
      baseRevision: base,
      files: [
        {
          path: "menu.txt",
          mediaType: "text/plain",
          content: revision,
          byteLength: new TextEncoder().encode(revision).byteLength,
          sha256: await sha256Hex(revision),
        },
      ],
    });
    const hash = await sha256Hex(manifest);
    const changeset = JSON.stringify({
      kind: base === null ? "genesis" : "fixture_revision",
      canonicalHead: hash,
    });
    const changesetHash = await sha256Hex(changeset);
    const prefix = `workspace-revisions/${scope.organisationId}/workspace_regional_copy`;
    const manifestKey = `${prefix}/manifests/${hash}.json`;
    const changesetKey = `${prefix}/changesets/${changesetHash}.json`;
    await env.ARCHIVE.put(manifestKey, manifest);
    await env.ARCHIVE.put(changesetKey, changeset);
    await scope.database
      .prepare(
        `INSERT INTO workspace_revision (
      organisation_id, workspace_id, revision_id, base_revision_id, canonical_head,
      manifest_ref, manifest_digest, changeset_ref, changeset_digest,
      correlation_id, causation_projection, committed_at
    ) VALUES (?, 'workspace_regional_copy', ?, ?, ?, ?, ?, ?, ?, 'regional-copy', '{}', 1)`,
      )
      .bind(
        scope.organisationId,
        revision,
        base,
        hash,
        manifestKey,
        hash,
        changesetKey,
        changesetHash,
      )
      .run();
    await scope.database
      .prepare(
        `INSERT INTO workspace_revision_head (organisation_id, workspace_id, revision_id, canonical_head, updated_at)
      VALUES (?, 'workspace_regional_copy', ?, ?, 1)
      ON CONFLICT (organisation_id, workspace_id) DO UPDATE SET revision_id = excluded.revision_id`,
      )
      .bind(scope.organisationId, revision, hash)
      .run();
    base = revision;
  }
}

type OrganisationBackupRecoveryFault =
  | { readonly kind: "clear" }
  | {
      readonly kind: "armed";
      readonly organisationId: OrganisationId;
      readonly neighborId: OrganisationId;
      readonly original: OrganisationDO["importPlacementState"];
    };
let organisationBackupRecoveryFault: OrganisationBackupRecoveryFault = {
  kind: "clear",
};

function armOrganisationBackupRecovery(
  organisationId: OrganisationId,
  neighborId: OrganisationId,
  actor: unknown,
): void {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  organisationBackupRecoveryFault = {
    kind: "armed",
    organisationId,
    neighborId,
    original: actor.importPlacementState,
  };
  Object.defineProperty(Object.getPrototypeOf(actor), "importPlacementState", {
    value: interruptOrganisationBackupRestore,
    configurable: true,
    writable: true,
  });
}

async function interruptRelocationJournal(
  relocationId: ActorRelocationId,
  transition: { readonly table: string; readonly condition: string },
): Promise<void> {
  await env.DB.prepare(
    `CREATE TRIGGER interrupt_relocation_journal BEFORE UPDATE ON ${transition.table}
     WHEN ${transition.condition} BEGIN SELECT RAISE(ABORT, 'relocation_journal_interrupted'); END`,
  ).run();
  try {
    await expect(
      resumeActorRelocation({ env, relocationId, now: Date.now() }),
    ).rejects.toThrow("relocation_journal_interrupted");
  } finally {
    await env.DB.prepare("DROP TRIGGER interrupt_relocation_journal").run();
  }
}

async function interruptOrganisationBackupRestore(
  this: OrganisationDO,
  input: ActorImportRequest,
): ReturnType<OrganisationDO["importPlacementState"]> {
  const fault = organisationBackupRecoveryFault;
  if (fault.kind !== "armed" || !env.ORGANISATION_DB_APAC)
    throw new Error("Missing recovery fault");
  organisationBackupRecoveryFault = { kind: "clear" };
  Object.defineProperty(Object.getPrototypeOf(this), "importPlacementState", {
    value: fault.original,
    configurable: true,
    writable: true,
  });
  const database = env.ORGANISATION_DB_APAC;
  const tables = await regionalCopyTables(database, database);
  const before = await countRegionalOrganisationRows(
    database,
    fault.organisationId,
    tables,
  );
  const neighborBefore = await countRegionalOrganisationRows(
    database,
    fault.neighborId,
    tables,
  );
  const deletion = [database.prepare("PRAGMA defer_foreign_keys = ON")];
  for (const table of [...tables].reverse()) {
    if (table.name === "organisation") continue;
    deletion.push(
      database
        .prepare(`DELETE FROM "${table.name}" WHERE ${table.predicate}`)
        .bind(fault.organisationId),
    );
  }
  const ownerGuard = await database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'service_role_grant_preserve_final_owner_on_delete'",
    )
    .first<{ sql: string }>();
  if (ownerGuard === null) throw new Error("Missing owner guard");
  await database
    .prepare("DROP TRIGGER service_role_grant_preserve_final_owner_on_delete")
    .run();
  try {
    await database.batch(deletion);
  } finally {
    await database.prepare(ownerGuard.sql).run();
  }
  expect(
    await countRegionalOrganisationRows(database, fault.organisationId, tables),
  ).toBe(1);
  await database
    .prepare(
      "CREATE TRIGGER interrupt_organisation_backup BEFORE INSERT ON person BEGIN SELECT RAISE(ABORT, 'organisation_backup_interrupted'); END",
    )
    .run();
  const interrupted = await fault.original.call(this, input);
  expect(interrupted).toMatchObject({
    ok: false,
    error: { code: "export_read_failed" },
  });
  await database.prepare("DROP TRIGGER interrupt_organisation_backup").run();
  const restored = await fault.original.call(this, input);
  expect(restored.ok).toBe(true);
  expect(
    await countRegionalOrganisationRows(database, fault.organisationId, tables),
  ).toBe(before);
  expect(
    await countRegionalOrganisationRows(database, fault.neighborId, tables),
  ).toBe(neighborBefore);
  return restored;
}

async function recoverWorkspaceArchiveFromRelocation(
  scope: OrganisationExecutionScope,
  relocationId: ActorRelocationId,
): Promise<void> {
  const keys = await workspaceRevisionArchiveKeys(
    scope.database,
    env.ARCHIVE,
    scope.organisationId,
  );
  if (!keys.ok) throw new Error(keys.error.code);
  const retained = await readRetainedActorRelocationExports({
    env,
    relocationId,
  });
  if (!retained.ok) throw new Error(retained.error.code);
  const organisationExport = retained.value.exports.find(isOrganisationArchive);
  if (organisationExport === undefined)
    throw new Error("Missing Organisation export");
  const loaded = await loadActorExport({
    bucket: env.ARCHIVE,
    root: env.DATA_ENCRYPTION_ROOT,
    ref: organisationExport.exportRef,
  });
  if (!loaded.ok) throw new Error(loaded.error.code);
  const bakeryKeys = await savedBakeryRunArchiveKeys(
    env.ARCHIVE,
    scope.organisationId,
  );
  expect(bakeryKeys).toHaveLength(1);
  const allKeys = [...keys.value, ...bakeryKeys];
  const exportedKeys = new Set(loaded.value.payload.r2.map(archiveSourceKey));
  for (const key of allKeys) expect(exportedKeys.has(key)).toBe(true);
  const firstKey = keys.value[0];
  if (firstKey === undefined) throw new Error("Missing workspace archive key");
  const backup = loaded.value.payload.r2.find(
    matchesArchiveSource.bind(null, firstKey),
  );
  if (backup === undefined) throw new Error("Missing workspace backup");
  const saved = await env.ARCHIVE.get(backup.archiveKey);
  if (saved === null) throw new Error("Missing retained workspace backup");
  const bytes = await saved.arrayBuffer();
  await env.ARCHIVE.delete(allKeys);
  await env.ARCHIVE.put(backup.archiveKey, "corrupt retained copy");
  expect(
    await restoreReferencedR2Objects(env.ARCHIVE, loaded.value.payload.r2),
  ).toEqual({
    ok: false,
    error: { code: "referenced_r2_corrupt", key: backup.archiveKey },
  });
  await env.ARCHIVE.put(backup.archiveKey, bytes);
  expect(
    await restoreReferencedR2Objects(env.ARCHIVE, loaded.value.payload.r2),
  ).toEqual({ ok: true, value: null });
  expect(
    await workspaceRevisionArchiveKeys(
      scope.database,
      env.ARCHIVE,
      scope.organisationId,
    ),
  ).toEqual(keys);
  expect(
    await savedBakeryRunArchiveKeys(env.ARCHIVE, scope.organisationId),
  ).toEqual(bakeryKeys);
  const restoredBakeryKey = bakeryKeys[0];
  if (restoredBakeryKey === undefined)
    throw new Error("Missing restored bakery run");
  const restoredBakery = await env.ARCHIVE.head(restoredBakeryKey);
  expect(restoredBakery?.httpMetadata?.contentType).toBe("application/json");
}

function isOrganisationArchive(value: RetainedActorRelocationExport): boolean {
  return value.identity.objectKind === "organisation";
}

function archiveSourceKey(value: ActorExportR2Object): string {
  return value.sourceKey;
}

function matchesArchiveSource(
  key: string,
  value: ActorExportR2Object,
): boolean {
  return value.sourceKey === key;
}

async function writeLateSessionState(
  value: string,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.put("regional-late-session-state", value);
}

async function readLateSessionState(
  _actor: unknown,
  state: DurableObjectState,
): Promise<string | undefined> {
  return state.storage.get<string>("regional-late-session-state");
}

it.skipIf(env.TEST_REGIONAL_MIGRATIONS.length === 0)(
  "abandons a copied target and recovers in the source region through a fresh epoch",
  regionalAbandonmentJourney,
  100_000,
);

async function regionalAbandonmentJourney({
  task,
}: TestContext): Promise<void> {
  if (!env.ORGANISATION_DB_WNAM || !env.ORGANISATION_DB_APAC)
    throw new Error("Regional bindings missing");
  const source = await onboardRegionalOrganisation("wnam", "abandon-source");
  await seedRegionalModelCredentials(source);
  const fundedRoutes = await readRegionalFundedModelRoutes(source);
  expect(fundedRoutes).toMatchObject([
    { ok: true, value: { keySource: "organisation_byo", provider: "openai" } },
    {
      ok: true,
      value: { keySource: "organisation_byo", provider: "anthropic" },
    },
  ]);
  const neighbor = await onboardRegionalOrganisation(
    "wnam",
    "abandon-neighbor",
  );
  const sessionId = parseSessionId("session_abandoned_regional_move");
  if (!sessionId.ok) throw new Error("Invalid session identity");
  const session = await requireActiveSessionActor({
    env,
    organisationId: source.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  await runInDurableObject(
    session,
    writeLateSessionState.bind(null, "accepted before source freeze"),
  );
  const oldOrganisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: source.organisationId,
    placement: source.placement,
    now: Date.now(),
  });
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "regional-apac",
    locationHint: "apac",
  });
  if (!target.ok) throw new Error(target.error.path);
  const started = await startActorRelocation({
    env,
    organisationId: source.organisationId,
    target: target.value,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  await env.DB.prepare(
    `CREATE TRIGGER interrupt_abandoned_publication BEFORE UPDATE ON state_object_relocation
    WHEN NEW.status = 'published' AND NEW.target_placement_epoch = 2
    BEGIN SELECT RAISE(ABORT, 'abandon_before_publication'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("abandon_before_publication");
  await env.DB.prepare("DROP TRIGGER interrupt_abandoned_publication").run();
  expect(await source.isActive()).toBe(false);
  const move = await readOrganisationPlacementMove({
    db: env.DB,
    organisationId: source.organisationId,
    sourcePlacementEpoch: 1,
    targetPlacementEpoch: 2,
  });
  if (
    !move.ok ||
    move.value.source.status !== "frozen" ||
    move.value.target.status !== "reserved"
  )
    throw new Error("Expected frozen move");
  expect(
    await publishOrganisationPlacementMove(
      env.DB,
      {
        organisationId: source.organisationId,
        source: move.value.source,
        target: move.value.target,
      },
      { kind: "relocation", operationId: started.value.relocationId },
      move.value.source.frozenAt + 300_001,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_move_conflict" },
  });
  const copied = await listPlacementActorRegistryEntries({
    db: organisationHandle(env.ORGANISATION_DB_APAC),
    organisationId: source.organisationId,
    placementEpoch: 2,
  });
  if (!copied.ok) throw new Error(copied.error.code);
  const copiedSession = actorStubForRegistryEntry({
    namespaces: {
      organisation: env.ORGANISATION,
      session: env.SESSION,
      case: env.CASE,
      connector: env.CONNECTOR,
    },
    entry: findRelocationSession(copied.value),
  });
  await env.DB.prepare(
    "UPDATE state_object_relocation SET frozen_at = ? WHERE relocation_id = ?",
  )
    .bind(Date.now() - 300_001, started.value.relocationId)
    .run();
  await env.DB.prepare(
    `CREATE TRIGGER interrupt_abandonment_transaction BEFORE INSERT ON state_object_relocation
    WHEN NEW.target_placement_epoch = 3
    BEGIN SELECT RAISE(ABORT, 'abandonment_transaction_interrupted'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("abandonment_transaction_interrupted");
  await env.DB.prepare("DROP TRIGGER interrupt_abandonment_transaction").run();
  expect(
    await readPlacementByEpoch(env.DB, source.organisationId, 2),
  ).toMatchObject({
    ok: true,
    value: { status: "reserved" },
  });
  expect(
    await env.DB.prepare(
      "SELECT status FROM state_object_relocation WHERE relocation_id = ?",
    )
      .bind(started.value.relocationId)
      .first(),
  ).toEqual({ status: "copying" });
  await env.DB.prepare(
    `CREATE TRIGGER interrupt_first_source_recovery BEFORE UPDATE ON state_object_relocation
    WHEN NEW.status = 'published' AND NEW.target_placement_epoch = 3
    BEGIN SELECT RAISE(ABORT, 'first_source_recovery_interrupted'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("first_source_recovery_interrupted");
  await env.DB.prepare("DROP TRIGGER interrupt_first_source_recovery").run();
  const original = await inspectActorRelocation({
    env,
    relocationId: started.value.relocationId,
  });
  if (!original.ok || original.value.relocation.status !== "abandoned")
    throw new Error("Expected abandoned original move");
  const firstRecoveryId = original.value.relocation.recoveryRelocationId;
  await env.ORGANISATION_DB_WNAM.prepare(
    `CREATE TRIGGER interrupt_abandoned_recovery BEFORE UPDATE ON organisation_placement
    WHEN NEW.status = 'active' AND NEW.placement_epoch = 4
    BEGIN SELECT RAISE(ABORT, 'recovery_after_publication'); END`,
  ).run();
  await expect(
    abandonActorRelocation({
      env,
      relocationId: firstRecoveryId,
      now: Date.now(),
    }),
  ).rejects.toThrow("recovery_after_publication");
  await env.ORGANISATION_DB_WNAM.prepare(
    "DROP TRIGGER interrupt_abandoned_recovery",
  ).run();
  const recovered = await resumeActorRelocation({
    env,
    relocationId: started.value.relocationId,
    now: Date.now() + 600_001,
  });
  if (!recovered.ok) throw new Error(recovered.error.code);
  if (recovered.value.status !== "retained")
    throw new Error("Expected retained recovery");
  expect(recovered.value.resumedAt - recovered.value.frozenAt).toBeGreaterThan(
    600_000,
  );
  expect(recovered.value).toMatchObject({
    status: "retained",
    sourcePlacementEpoch: 1,
    targetPlacementEpoch: 4,
  });
  expect(
    await publishOrganisationPlacementMove(
      env.DB,
      {
        organisationId: source.organisationId,
        source: move.value.source,
        target: move.value.target,
      },
      { kind: "relocation", operationId: started.value.relocationId },
      move.value.source.frozenAt + 1,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_move_conflict" },
  });
  const current = await OrganisationExecutionScope.resolve(
    env,
    source.organisationId,
  );
  if (!current.ok) throw new Error(current.error.code);
  expect(current.value.placement).toMatchObject({
    placementCellId: "regional-wnam",
    placementEpoch: 4,
  });
  expect(await current.value.isActive()).toBe(true);
  expect(await source.isActive()).toBe(false);
  expect(await readRegionalFundedModelRoutes(current.value)).toEqual(
    fundedRoutes,
  );
  expect(await readRegionalFundedModelRoutes(source)).toMatchObject([
    { ok: false, error: { code: "organisation_openai_api_key_unavailable" } },
    {
      ok: false,
      error: { code: "organisation_anthropic_api_key_unavailable" },
    },
  ]);
  expect(
    await readOrganisationCodexConnectionAtScope({
      env,
      scope: source,
      now: Date.now(),
      reconcile: false,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_conflict" },
  });
  Object.assign(task.meta, { fundedModelRoutesRetainCapturedPlacement: true });
  expect(await neighbor.isActive()).toBe(true);
  expect(
    await oldOrganisation.getOrganisation({
      requestingOrganisationId: source.organisationId,
    }),
  ).toMatchObject({ ok: false });
  const recoveredSession = await requireActiveSessionActor({
    env,
    organisationId: source.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  await evictDurableObject(recoveredSession);
  expect(await runInDurableObject(recoveredSession, readLateSessionState)).toBe(
    "accepted before source freeze",
  );
  const abandoned = await readPlacementByEpoch(
    env.DB,
    source.organisationId,
    2,
  );
  if (!abandoned.ok) throw new Error(abandoned.error.code);
  expect(abandoned.value.status).toBe("abandoned");
  expect(
    await OrganisationExecutionScope.resolveAtPlacement(
      env,
      source.organisationId,
      abandoned.value.placement,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "organisation_placement_conflict" },
  });
  expect(
    await env.ORGANISATION_DB_APAC.prepare(
      "SELECT status FROM organisation WHERE organisation_id = ?",
    )
      .bind(source.organisationId)
      .first(),
  ).toEqual({ status: "deleted" });
  expect(
    await abandonActorRelocation({
      env,
      relocationId: recovered.value.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: false, error: { code: "relocation_conflict" } });
  expect(
    await abandonActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({
    ok: true,
    value: { relocationId: recovered.value.relocationId },
  });
  expect(await runInDurableObject(copiedSession, readLateSessionState)).toBe(
    "accepted before source freeze",
  );
  await env.DB.prepare(
    "UPDATE state_object_relocation SET resumed_at = ?, retain_until = ? WHERE relocation_id = ?",
  )
    .bind(
      Date.now() - 8 * 24 * 60 * 60 * 1_000,
      Date.now() - 1,
      recovered.value.relocationId,
    )
    .run();
  expect(
    await resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { status: "complete" } });
  expect(
    await runInDurableObject(copiedSession, readLateSessionState),
  ).toBeUndefined();
  const next = await startActorRelocation({
    env,
    organisationId: source.organisationId,
    target: target.value,
    now: Date.now(),
  });
  if (!next.ok) throw new Error(next.error.code);
  expect(next.value.targetPlacementEpoch).toBe(5);
  expect(
    await resumeActorRelocation({
      env,
      relocationId: next.value.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({
    ok: true,
    value: { status: "retained", targetPlacementEpoch: 5 },
  });
  const finalSession = await requireActiveSessionActor({
    env,
    organisationId: source.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  expect(await runInDurableObject(finalSession, readLateSessionState)).toBe(
    "accepted before source freeze",
  );
  Object.assign(task.meta, {
    regionalAbandonment: {
      postPublicationBudgetOverrunRecovered: true,
      publicationDeadlineEnforced: true,
      automaticSourceRecovery: true,
      abandonedActorsErasedAfterRetention: true,
      repeatedAbandonmentRecovered: true,
      copiedTargetDisabled: true,
      sourceEpochNeverReopened: true,
      freshSourceRegionEpoch: 4,
      recoveredAfterPublicationInterruption: true,
      abandonedEpochNotReused: true,
      nextSuccessfulTargetEpoch: 5,
      neighboringOrganisationPreserved: true,
      postPublicationAbandonmentRejected: true,
    },
  });
}

function findRelocationSession(
  entries: readonly ActorRegistryEntry[],
): ActorRegistryEntry {
  for (const entry of entries)
    if (entry.identity.objectKind === "session") return entry;
  throw new Error("Copied session missing");
}

function fullCapacitySession(
  original: D1Database["withSession"],
  ...args: Parameters<D1Database["withSession"]>
): D1DatabaseSession {
  const session = original(...args);
  Object.defineProperty(session, "prepare", {
    configurable: true,
    value: prepareFullCapacity.bind(null, session.prepare.bind(session)),
  });
  return session;
}

function prepareFullCapacity(
  original: D1DatabaseSession["prepare"],
  query: string,
): D1PreparedStatement {
  const statement = original(query);
  Object.defineProperty(statement, "all", {
    configurable: true,
    value: reportFullCapacity.bind(null, statement.all.bind(statement)),
  });
  return statement;
}

async function reportFullCapacity(
  original: D1PreparedStatement["all"],
): Promise<D1Result> {
  const result = await original();
  result.meta.size_after = 10_000_000_000;
  return result;
}

it.skipIf(env.TEST_REGIONAL_MIGRATIONS.length === 0)(
  "restores retired identities in a regional database after interrupted publication",
  regionalRetirementRecoveryJourney,
  100_000,
);

async function regionalRetirementRecoveryJourney({
  task,
}: TestContext): Promise<void> {
  const source = await onboardRegionalOrganisation("wnam", "retirement-source");
  const neighbor = await onboardRegionalOrganisation(
    "apac",
    "retirement-neighbor",
  );
  const sessionId = parseSessionId("session_retired_regional_recovery");
  if (!sessionId.ok) throw new Error("Invalid retirement identity");
  await requireActiveSessionActor({
    env,
    organisationId: source.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  const registry = await listPlacementActorRegistryEntries({
    db: source.database,
    organisationId: source.organisationId,
    placementEpoch: source.placement.placementEpoch,
  });
  if (!registry.ok) throw new Error(registry.error.code);
  const entry = registry.value.find(isSessionRegistryEntry);
  if (entry === undefined) throw new Error("Missing Session registry entry");
  const exporting = await beginActorExport({
    db: source.database,
    registryId: entry.registryId,
    expectedFenceToken: entry.fenceToken,
    now: Date.now(),
  });
  if (!exporting.ok) throw new Error(exporting.error.code);
  const retired = await retireActorRegistryEntry({
    db: source.database,
    registryId: entry.registryId,
    expectedFenceToken: entry.fenceToken,
    now: Date.now(),
  });
  if (!retired.ok) throw new Error(retired.error.code);
  const canvas = await seedRegionalCanvas(source);
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "regional-apac",
    locationHint: "apac",
  });
  if (!target.ok) throw new Error(target.error.path);
  const relocation = await startActorRelocation({
    env,
    organisationId: source.organisationId,
    target: target.value,
    now: Date.now(),
  });
  if (!relocation.ok) throw new Error(relocation.error.code);
  const moved = await resumeActorRelocation({
    env,
    relocationId: relocation.value.relocationId,
    now: Date.now(),
  });
  expect(moved, JSON.stringify(moved)).toMatchObject({
    ok: true,
    value: { status: "retained" },
  });
  await verifyRegionalCanvas(canvas);
  const manifest = await prepareActorRestoreManifest({
    env,
    relocationId: relocation.value.relocationId,
    now: Date.now(),
  });
  if (!manifest.ok) throw new Error(manifest.error.code);
  expect(manifest.value.retiredActors).toHaveLength(1);
  const active = await OrganisationExecutionScope.resolve(
    env,
    source.organisationId,
  );
  if (!active.ok) throw new Error(active.error.code);
  // Configuration remains recovered in APAC; simulate loss of its Actor registry.
  await env.DB.prepare(
    "DELETE FROM state_object_relocation_item WHERE relocation_id = ?",
  )
    .bind(relocation.value.relocationId)
    .run();
  await active.value.database
    .prepare("DELETE FROM durable_object_registry WHERE organisation_id = ?")
    .bind(source.organisationId)
    .run();
  await active.value.database
    .prepare(
      "DELETE FROM portal_conversation WHERE organisation_id = ? AND access_kind = 'workspace_canvas'",
    )
    .bind(source.organisationId)
    .run();
  const restore = await startActorRestore({
    env,
    manifest: manifest.value,
    target: target.value,
    now: Date.now(),
  });
  if (!restore.ok) throw new Error(restore.error.code);
  await active.value.database
    .prepare(
      "CREATE TRIGGER interrupt_retired_restore_resume BEFORE UPDATE OF status ON organisation_placement WHEN NEW.status = 'active' AND OLD.status = 'reserved' BEGIN SELECT RAISE(ABORT, 'regional_restore_resume_interrupted'); END",
    )
    .run();
  try {
    await expect(
      resumeActorRestore({
        env,
        restoreId: restore.value.restoreId,
        now: Date.now(),
      }),
    ).rejects.toThrow("regional_restore_resume_interrupted");
    expect(
      await OrganisationExecutionScope.resolve(env, source.organisationId),
    ).toMatchObject({ ok: false });
  } finally {
    await active.value.database
      .prepare("DROP TRIGGER interrupt_retired_restore_resume")
      .run();
  }
  const resumed = await resumeActorRestore({
    env,
    restoreId: restore.value.restoreId,
    now: Date.now(),
  });
  expect(resumed, JSON.stringify(resumed)).toMatchObject({
    ok: true,
    value: { status: "complete" },
  });
  const recovered = await OrganisationExecutionScope.resolve(
    env,
    source.organisationId,
  );
  if (!recovered.ok) throw new Error(recovered.error.code);
  expect(recovered.value.placement.locationHint).toBe("apac");
  await verifyRegionalCanvas(canvas);
  await continueRecoveredCanvas(recovered.value, canvas);
  const recoveredRegistry = await listPlacementActorRegistryEntries({
    db: recovered.value.database,
    organisationId: source.organisationId,
    placementEpoch: recovered.value.placement.placementEpoch,
  });
  if (!recoveredRegistry.ok) throw new Error(recoveredRegistry.error.code);
  expect(recoveredRegistry.value.find(isRetiredRecoverySession)).toMatchObject({
    lifecycleStatus: "retired",
  });
  await expect(
    requireActiveSessionActor({
      env,
      organisationId: source.organisationId,
      sessionId: sessionId.value,
      now: Date.now(),
    }),
  ).rejects.toThrow();
  expect(await source.isActive()).toBe(false);
  expect(await neighbor.isActive()).toBe(true);
  Object.assign(task.meta, {
    regionalRetirementRecovery: {
      source: "wnam",
      recovered: "apac",
      interruptedResumeRecovered: true,
      retiredSessionPreserved: true,
      canvasGenerations: 2,
      canvasEarlierHistory: "readable after relocation and restore",
      canvasDeletedRows: "recovered from export",
      canvasContinuedAfterRestore: "generation 3 completed",
      recreationRejected: true,
      neighborUnaffected: true,
    },
  });
}

function isSessionRegistryEntry(entry: ActorRegistryEntry): boolean {
  return entry.identity.objectKind === "session";
}

function isRetiredRecoverySession(entry: ActorRegistryEntry): boolean {
  return (
    entry.identity.objectKind === "session" &&
    entry.identity.logicalObjectId === "session_retired_regional_recovery"
  );
}

async function seedRegionalModelCredentials(
  scope: OrganisationExecutionScope,
): Promise<void> {
  const openai = parseModelApiKey("openai",
    "sk-project-regional-openai-test-1234567890",
  );
  const anthropic = parseModelApiKey("anthropic",
    "sk-ant-api03-regional-test-1234567890",
  );
  if (!openai.ok || !anthropic.ok) throw new Error("Invalid model key fixture");
  const stored = await Promise.all([
    storeOrganisationModelCredential({
      provider: "openai",
      db: scope.database,
      keys: env,
      organisationId: scope.organisationId,
      apiKey: openai.value,
      now: Date.now(),
    }),
    storeOrganisationModelCredential({
      provider: "anthropic",
      db: scope.database,
      keys: env,
      organisationId: scope.organisationId,
      apiKey: anthropic.value,
      now: Date.now(),
    }),
  ]);
  expect(stored).toMatchObject([{ ok: true }, { ok: true }]);
}

async function readRegionalFundedModelRoutes(
  scope: OrganisationExecutionScope,
) {
  return Promise.all([
    resolveOrganisationModelRouteForSelection({
      env,
      scope,
      now: Date.now(),
      selection: { kind: "organisation_openai_api_key" },
    }),
    resolveOrganisationModelRouteForSelection({
      env,
      scope,
      now: Date.now(),
      selection: { kind: "organisation_anthropic_api_key" },
    }),
  ]);
}

function isCaseRegistryEntry(entry: ActorRegistryEntry): boolean {
  return entry.identity.objectKind === "case";
}

async function verifyClosedCaseAdmission(
  scope: OrganisationExecutionScope,
): Promise<void> {
  const registry = await listPlacementActorRegistryEntries({
    db: scope.database,
    organisationId: scope.organisationId,
    placementEpoch: scope.placement.placementEpoch,
  });
  if (!registry.ok) throw new Error(registry.error.code);
  const entry = registry.value.find(isCaseRegistryEntry);
  if (entry === undefined) throw new Error("Missing source Case");
  const actor = actorStub(
    env.CASE,
    entry.physicalObjectName,
    entry.placement,
  );
  const before = await actor.inspect();
  if (!before.ok) throw new Error(before.error.code);
  const assignment = before.value.assignmentLifecycles[0]?.assignment;
  if (assignment === undefined)
    throw new Error("Missing source Case assignment");
  expect(
    await actor.assignSession({
      assignmentId: "assignment_closed_source_probe",
      caseId: before.value.identity.caseId,
      caseRevision: before.value.revision,
      sessionId: "session_closed_source_probe",
      role: assignment.role,
      objective: assignment.objective,
      authority: assignment.authority,
      authorityPartition: assignment.authorityPartition,
      budget: assignment.budget,
      context: {
        caseId: before.value.identity.caseId,
        revision: before.value.revision,
        journalCursor: before.value.journalCursor,
        workspaceRevision: before.value.workspaceRevision,
        entries: before.value.entries,
        evidenceDependency: assignment.context.evidenceDependency,
      },
    }),
  ).toEqual({
    ok: false,
    error: { code: "case_execution_authority_inactive" },
  });
  expect(
    await actor.ensure({
      identity: before.value.identity,
      purpose: before.value.purpose,
      workspaceRevision: before.value.workspaceRevision,
      lifecycle: before.value.lifecycle,
    }),
  ).toEqual({
    ok: false,
    error: { code: "case_execution_authority_inactive" },
  });
  expect(await actor.inspect()).toEqual(before);
}

async function waiveRetentionRequest(
  relocationId: string,
  authorized: boolean,
  discardRecoveryCopy: boolean,
): Promise<Response> {
  return exports.default.fetch(
    new Request("https://localhost/v1/admin/state-object-relocation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorized
          ? `Bearer ${env.ORGANISATION_ADMIN_TOKEN}`
          : "Bearer invalid",
      },
      body: JSON.stringify({
        command: "waive_retention",
        relocationId,
        discardRecoveryCopy,
      }),
    }),
  );
}
