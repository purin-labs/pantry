/// <reference types="@cloudflare/workers-types" />

import type { UnitTestEnv } from "./worker-fakes";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  listOrganisationActorRegistryEntries,
  parseActorActivationToken,
  parseActorFenceToken,
  parseActorRegistryId,
  actorActivationIdentity,
  type ActorActivationRequest,
  type ActorRegistryEntry,
  type ActorIdentity,
} from "../src/actors/actor-registry";
import {
  resolveActiveOrganisationPlacement,
  parseOrganisationPlacementMoveTarget,
} from "@purin-labs/tenancy/data/organisation-placement";
import {
  activateActor,
  createActorActivationSchema,
} from "../src/actors/actor-activation";
import {
  captureActorExport,
  newActorExportId,
  type ActorExportRef,
} from "../src/actors/actor-export";
import {
  parseCaseId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { prepareActorRestoreManifest } from "../src/actors/actor-restore-manifest";
import {
  inspectActorRestore,
  resumeActorRestore,
  startActorRestore,
} from "../src/actors/actor-restore";
import {
  parseActorRelocationId,
  type ActorRelocationId,
} from "../src/actors/actor-relocation";
import {
  emptySqliteFixture,
  sqlStorage,
  type TestSqlStorage,
} from "./sqlite-storage";
import type { VariantBy } from "@purin-labs/type-utils";
import { d1Database, readMigration } from "./sqlite-d1";

describe("actor restore", function actorRestoreSuite() {
  it("holds publication until every archived object is active in the clean account", async function restoresAcrossIndependentPlacementEpochs() {
    const organisationId = requiredOrganisationId();
    const channelId = requiredCaseId();
    const bucket = new TestR2Bucket();
    const root = testRootSecret();
    const organisationIdentity: ActorIdentity = {
      objectKind: "organisation",
      organisationId,
      logicalObjectId: organisationId,
    };
    const surfaceIdentity: ActorIdentity = {
      objectKind: "case",
      organisationId,
      logicalObjectId: channelId,
    };
    const organisationExport = await capturedExport({
      identity: organisationIdentity,
      placementEpoch: 7,
      bucket,
      root,
      now: 700,
    });
    const surfaceExport = await capturedExport({
      identity: surfaceIdentity,
      placementEpoch: 7,
      bucket,
      root,
      now: 701,
    });
    const origin = originFixture({
      organisationId,
      organisationExport,
      surfaceExport,
    });
    const manifest = await prepareActorRestoreManifest({
      env: {
        DB: origin.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
          databaseBinding: "DB",
          kind: "affinity",
          placementCellId: "archive-target",
          locationHint: "wnam",
          cells: [
            {
              databaseBinding: "DB",
              kind: "affinity",
              placementCellId: "archive-origin",
              locationHint: "wnam",
            },
          ],
        }),
        ARCHIVE: bucket.r2Bucket(),
        DATA_ENCRYPTION_ROOT: root,
      },
      relocationId: origin.relocationId,
      now: 800,
    });

    if (!manifest.ok) {
      throw new Error(`manifest preparation failed: ${manifest.error.code}`);
    }
    expect(manifest.ok).toBe(true);

    const target = targetFixture({ organisationId, bucket, root });
    const moveTarget = parseOrganisationPlacementMoveTarget({
      kind: "residency",
      placementCellId: "eu-preview",
      locationHint: "weur",
      residencyJurisdiction: "eu",
    });

    if (!moveTarget.ok) {
      throw new Error("restore target fixture invariant failed");
    }

    const started = await startActorRestore({
      env: target.env,
      manifest: manifest.value,
      target: moveTarget.value,
      now: 900,
    });

    expect(started).toMatchObject({
      ok: true,
      value: {
        status: "reserved",
        exportSourcePlacementEpoch: 7,
        localSourcePlacementEpoch: 1,
        targetPlacementEpoch: 2,
      },
    });

    if (!started.ok) {
      throw new Error(`restore start failed: ${started.error.code}`);
    }

    const interrupted = await resumeActorRestore({
      env: target.env,
      restoreId: started.value.restoreId,
      now: 1_000,
    });
    const interruptedInspection = await inspectActorRestore({
      db: target.env.DB,
      restoreId: started.value.restoreId,
    });

    expect(interrupted).toEqual({
      ok: false,
      error: { code: "export_missing" },
    });
    expect(interruptedInspection).toMatchObject({
      ok: true,
      value: {
        restore: {
          status: "importing",
          exportSourcePlacementEpoch: 7,
          localSourcePlacementEpoch: 1,
          targetPlacementEpoch: 2,
        },
        items: [
          { object: { identity: { objectKind: "case" } }, status: "imported" },
          {
            object: { identity: { objectKind: "organisation" } },
            status: "pending",
          },
        ],
      },
    });
    expect(
      target.database
        .prepare(
          `SELECT placement_epoch, status FROM organisation_placement ORDER BY placement_epoch`,
        )
        .all(),
    ).toEqual([
      { placement_epoch: 1, status: "frozen" },
      { placement_epoch: 2, status: "reserved" },
    ]);

    const completed = await resumeActorRestore({
      env: target.env,
      restoreId: started.value.restoreId,
      now: 1_100,
    });
    const retried = await resumeActorRestore({
      env: target.env,
      restoreId: started.value.restoreId,
      now: 1_200,
    });
    const activePlacement = await resolveActiveOrganisationPlacement(
      target.env.DB,
      organisationId,
    );
    const registry = await listOrganisationActorRegistryEntries({
      db: target.env.DB,
      organisationId,
    });

    expect(completed).toMatchObject({
      ok: true,
      value: {
        status: "complete",
        exportSourcePlacementEpoch: 7,
        localSourcePlacementEpoch: 1,
        targetPlacementEpoch: 2,
      },
    });
    expect(retried).toEqual(completed);
    expect(activePlacement).toMatchObject({
      ok: true,
      value: {
        kind: "residency",
        placementEpoch: 2,
        residencyJurisdiction: "eu",
      },
    });
    expect(registry).toMatchObject({
      ok: true,
      value: [
        { identity: { objectKind: "case" }, lifecycleStatus: "active" },
        { identity: { objectKind: "organisation" }, lifecycleStatus: "active" },
      ],
    });
    expect(target.namespace.importAttempts).toEqual({
      case: 1,
      organisation: 2,
    });
  });
});

type RestoreBindings = Pick<
  UnitTestEnv,
  | "PANTRY_ORGANISATION_PLACEMENT_PROFILE"
  | "DB"
  | "ARCHIVE"
  | "DATA_ENCRYPTION_ROOT"
  | "ORGANISATION"
  | "CASE"
  | "SESSION"
  | "CONNECTOR"
>;

type OriginFixture = {
  readonly db: SingleDatabase;
  readonly relocationId: ActorRelocationId;
};

type TargetFixture = {
  readonly database: DatabaseSync;
  readonly env: RestoreBindings;
  readonly namespace: FakeRestoreNamespace;
};

function originFixture(input: {
  readonly organisationId: OrganisationId;
  readonly organisationExport: ActorExportRef;
  readonly surfaceExport: ActorExportRef;
}): OriginFixture {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, ["0001_current_schema.sql"]);
  insertOrganisation(database, input.organisationId, "Restore Origin");
  insertPlacementHistory(database, input.organisationId, 7, 8);
  insertOriginRegistry(
    database,
    input.organisationId,
    "organisation",
    input.organisationId,
  );
  insertOriginRegistry(
    database,
    input.organisationId,
    "case",
    requiredCaseId(),
  );

  const relocationId = requiredRelocationId();
  database
    .prepare(
      `INSERT INTO state_object_relocation (
       relocation_id,
       organisation_id,
       source_placement_epoch,
       target_placement_epoch,
       status,
       created_at,
       frozen_at,
       published_at,
       resumed_at,
       retain_until,
       preflight_at, preflight_row_count, preflight_table_count, preflight_actor_bytes, preflight_actor_count
     )
     VALUES (?, ?, 7, 8, 'retained', 600, 610, 620, 630, 604800630, 600, 2, 1, 0, 2)`,
    )
    .run(relocationId, input.organisationId);
  insertRelocationItem({
    database,
    relocationId,
    identity: {
      objectKind: "organisation",
      organisationId: input.organisationId,
      logicalObjectId: input.organisationId,
    },
    exportRef: input.organisationExport,
  });
  insertRelocationItem({
    database,
    relocationId,
    identity: {
      objectKind: "case",
      organisationId: input.organisationId,
      logicalObjectId: requiredCaseId(),
    },
    exportRef: input.surfaceExport,
  });

  return {
    db: d1Database(database),
    relocationId,
  };
}

function targetFixture(input: {
  readonly organisationId: OrganisationId;
  readonly bucket: TestR2Bucket;
  readonly root: SecretsStoreSecret;
}): TargetFixture {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, ["0001_current_schema.sql"]);
  insertOrganisation(database, input.organisationId, "Restore Target");
  database
    .prepare(
      `INSERT INTO organisation_placement (
       organisation_id,
       placement_epoch,
       placement_kind,
       placement_cell_id,
       location_hint,
       residency_jurisdiction,
       status,
       fence_token,
       created_at,
       activated_at
     )
     VALUES (?, 1, 'affinity', 'multi-region-preview', 'wnam', NULL, 'active',
       'tpf_restore_target', 1, 1)`,
    )
    .run(input.organisationId);

  const namespace = new FakeRestoreNamespace();
  const db = d1Database(database);

  return {
    database,
    namespace,
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
        databaseBinding: "DB",
        kind: "affinity",
        placementCellId: "multi-region-preview",
        locationHint: "wnam",
        cells: [
          {
            databaseBinding: "DB",
            kind: "residency",
            placementCellId: "eu-preview",
            locationHint: "weur",
            residencyJurisdiction: "eu",
          },
        ],
      }),
      ARCHIVE: input.bucket.r2Bucket(),
      DATA_ENCRYPTION_ROOT: input.root,
      ORGANISATION: namespace.asOrganisationNamespace(),
      CASE: namespace.asCaseNamespace(),
      SESSION: namespace.asSessionNamespace(),
      CONNECTOR: namespace.asConnectorNamespace(),
    },
  };
}

async function capturedExport(input: {
  readonly identity: ActorIdentity;
  readonly placementEpoch: number;
  readonly bucket: TestR2Bucket;
  readonly root: SecretsStoreSecret;
  readonly now: number;
}): Promise<ActorExportRef> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const storage = new TestDurableObjectStorage(fixture.storage);
  createActorActivationSchema(sql);
  const reserved = reservedRegistryEntry(input.identity, input.placementEpoch);
  const activated = activateActor(
    sql,
    actorActivationIdentity(reserved, input.now - 1),
  );

  if (!activated.ok) {
    throw new Error("source activation fixture failed");
  }

  const captured = await captureActorExport({
    storage: storage.durableStorage(),
    bucket: input.bucket.r2Bucket(),
    root: input.root,
    expectedFenceToken: reserved.fenceToken,
    exportId: newActorExportId(),
    referencedR2Keys: [],
    now: input.now,
  });

  if (!captured.ok) {
    throw new Error(`source export fixture failed: ${captured.error.code}`);
  }

  return captured.value;
}

function reservedRegistryEntry(
  identity: ActorIdentity,
  placementEpoch: number,
): VariantBy<ActorRegistryEntry, "lifecycleStatus", "reserved"> {
  const registryId = parseActorRegistryId(
    `dor_restore_source_${identity.objectKind}`,
  );
  const activationToken = parseActorActivationToken(
    `doa_restore_source_${identity.objectKind}`,
  );
  const fenceToken = parseActorFenceToken(
    `dof_restore_source_${identity.objectKind}`,
  );
  const placement = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch,
    placementCellId: "archive-origin",
    locationHint: "wnam",
  });

  if (
    !registryId.ok ||
    !activationToken.ok ||
    !fenceToken.ok ||
    !placement.ok
  ) {
    throw new Error("source registry fixture invariant failed");
  }

  return {
    registryId: registryId.value,
    activationToken: activationToken.value,
    identity,
    physicalObjectName: `${identity.organisationId}:${identity.objectKind}:p${placementEpoch}`,
    placement: placement.value,
    schemaVersion: 1,
    stateVersion: 0,
    fenceToken: fenceToken.value,
    reservedAt: 1,
    lifecycleStatus: "reserved",
  };
}

function insertOrganisation(
  database: DatabaseSync,
  organisationId: OrganisationId,
  name: string,
): void {
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, ?, 'beta', 1, 'active')`,
    )
    .run(organisationId, name);
}

function insertPlacementHistory(
  database: DatabaseSync,
  organisationId: OrganisationId,
  sourceEpoch: number,
  targetEpoch: number,
): void {
  database
    .prepare(
      `INSERT INTO organisation_placement (
       organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
       residency_jurisdiction, status, fence_token, created_at, activated_at, frozen_at,
       retired_at
     ) VALUES (?, ?, 'affinity', 'archive-origin', 'wnam', NULL, 'retired',
       'tpf_origin_source', 1, 2, 3, 4)`,
    )
    .run(organisationId, sourceEpoch);
  database
    .prepare(
      `INSERT INTO organisation_placement (
       organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
       residency_jurisdiction, status, fence_token, created_at, activated_at
     ) VALUES (?, ?, 'affinity', 'archive-target', 'wnam', NULL, 'active',
       'tpf_origin_target', 5, 6)`,
    )
    .run(organisationId, targetEpoch);
}

function insertOriginRegistry(
  database: DatabaseSync,
  organisationId: OrganisationId,
  objectKind: "organisation" | "case",
  logicalObjectId: string,
): void {
  database
    .prepare(
      `INSERT INTO durable_object_registry (
       registry_id, activation_token, organisation_id, object_kind, logical_object_id,
       physical_object_name, placement_epoch, placement_cell_id, schema_version,
       state_version, lifecycle_status, fence_token, reserved_at, activated_at,
       exporting_at, retired_at
     ) VALUES (?, ?, ?, ?, ?, ?, 7, 'archive-origin', 1, 1, 'retired', ?, 1, 2, 3, 4)`,
    )
    .run(
      sourceRegistryId(objectKind),
      `doa_origin_source_${objectKind}`,
      organisationId,
      objectKind,
      logicalObjectId,
      `${organisationId}:${objectKind}:p7`,
      `dof_origin_source_${objectKind}`,
    );
  database
    .prepare(
      `INSERT INTO durable_object_registry (
       registry_id, activation_token, organisation_id, object_kind, logical_object_id,
       physical_object_name, placement_epoch, placement_cell_id, schema_version,
       state_version, lifecycle_status, fence_token, reserved_at, activated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 8, 'archive-target', 1, 1, 'active', ?, 5, 6)`,
    )
    .run(
      targetRegistryId(objectKind),
      `doa_origin_target_${objectKind}`,
      organisationId,
      objectKind,
      logicalObjectId,
      `${organisationId}:${objectKind}:p8`,
      `dof_origin_target_${objectKind}`,
    );
}

function insertRelocationItem(input: {
  readonly database: DatabaseSync;
  readonly relocationId: ActorRelocationId;
  readonly identity: ActorIdentity;
  readonly exportRef: ActorExportRef;
}): void {
  input.database
    .prepare(
      `INSERT INTO state_object_relocation_item (
       relocation_id, object_kind, logical_object_id, source_registry_id,
       target_registry_id, export_id, export_key, export_organisation_id,
       export_payload_digest_b64, export_created_at, status, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retired', 630)`,
    )
    .run(
      input.relocationId,
      input.identity.objectKind,
      input.identity.logicalObjectId,
      sourceRegistryId(input.identity.objectKind),
      targetRegistryId(input.identity.objectKind),
      input.exportRef.exportId,
      input.exportRef.key,
      input.exportRef.organisationId,
      input.exportRef.payloadDigestB64,
      input.exportRef.createdAt,
    );
}

function sourceRegistryId(objectKind: ActorIdentity["objectKind"]): string {
  return `dor_origin_source_${objectKind}`;
}

function targetRegistryId(objectKind: ActorIdentity["objectKind"]): string {
  return `dor_origin_target_${objectKind}`;
}

function requiredOrganisationId(): OrganisationId {
  const parsed = parseOrganisationId("organisation_restore_test");

  if (!parsed.ok) {
    throw new Error("organisation fixture invariant failed");
  }

  return parsed.value;
}

function requiredCaseId() {
  const parsed = parseCaseId("channel_restore_test");

  if (!parsed.ok) {
    throw new Error("channel fixture invariant failed");
  }

  return parsed.value;
}

function requiredRelocationId(): ActorRelocationId {
  const parsed = parseActorRelocationId(
    "dor_move_00000000-0000-4000-8000-000000000007",
  );

  if (!parsed.ok) {
    throw new Error("relocation fixture invariant failed");
  }

  return parsed.value;
}

function applyMigrations(
  database: DatabaseSync,
  names: readonly string[],
): void {
  for (const name of names) {
    database.exec(readMigration(name));
  }
}

function testRootSecret(): SecretsStoreSecret {
  return { get: resolveTestRoot } as unknown as SecretsStoreSecret;
}

async function resolveTestRoot(): Promise<string> {
  return Buffer.alloc(32, 11).toString("base64");
}

class FakeRestoreNamespace {
  readonly stubs = new Map<string, FakeRestoreStub>();
  readonly importAttempts = { case: 0, organisation: 0 };

  idFromName(name: string): DurableObjectId {
    return name as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): FakeRestoreStub {
    const name = id as unknown as string;
    const current = this.stubs.get(name);

    if (current !== undefined) {
      return current;
    }

    const created = new FakeRestoreStub(this);
    this.stubs.set(name, created);
    return created;
  }

  jurisdiction(): FakeRestoreNamespace {
    return this;
  }

  asOrganisationNamespace(): UnitTestEnv["ORGANISATION"] {
    return this as unknown as UnitTestEnv["ORGANISATION"];
  }

  asCaseNamespace(): UnitTestEnv["CASE"] {
    return this as unknown as UnitTestEnv["CASE"];
  }

  asSessionNamespace(): UnitTestEnv["SESSION"] {
    return this as unknown as UnitTestEnv["SESSION"];
  }

  asConnectorNamespace(): UnitTestEnv["CONNECTOR"] {
    return this as unknown as UnitTestEnv["CONNECTOR"];
  }
}

class FakeRestoreStub {
  private activation: ActorActivationRequest | null = null;

  constructor(private readonly namespace: FakeRestoreNamespace) {}

  async activate(input: ActorActivationRequest) {
    this.activation = input;
    return {
      ok: true as const,
      value: {
        kind: "activated" as const,
        registryId: input.registryId,
        stateVersion: 1,
      },
    };
  }

  async importPlacementState() {
    if (this.activation === null) {
      return {
        ok: false as const,
        error: { code: "actor_not_activated" as const },
      };
    }

    const kind = this.activation.identity.objectKind;

    if (kind !== "organisation" && kind !== "case") {
      return { ok: false as const, error: { code: "export_missing" as const } };
    }

    this.namespace.importAttempts[kind] += 1;

    if (
      kind === "organisation" &&
      this.namespace.importAttempts.organisation === 1
    ) {
      return { ok: false as const, error: { code: "export_missing" as const } };
    }

    return { ok: true as const, value: { stateVersion: 1 } };
  }
}

class TestDurableObjectStorage {
  constructor(readonly sql: TestSqlStorage) {}

  durableStorage(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }

  async list<T>(): Promise<Map<string, T>> {
    return new Map<string, T>();
  }

  async getAlarm(): Promise<number | null> {
    return null;
  }
}

class TestR2Bucket {
  private readonly objects = new Map<string, ArrayBuffer>();

  r2Bucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
  ): Promise<R2Object> {
    const bytes =
      value instanceof ArrayBuffer
        ? value.slice(0)
        : copyArrayBuffer(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          );
    this.objects.set(key, bytes);
    return {} as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : testR2ObjectBody(value);
  }
}

function testR2ObjectBody(value: ArrayBuffer): R2ObjectBody {
  return {
    size: value.byteLength,
    arrayBuffer: testR2ArrayBuffer.bind(null, value),
  } as unknown as R2ObjectBody;
}

async function testR2ArrayBuffer(value: ArrayBuffer): Promise<ArrayBuffer> {
  return value.slice(0);
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
