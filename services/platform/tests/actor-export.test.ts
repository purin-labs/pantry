/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  parseActorActivationToken,
  parseActorFenceToken,
  parseActorRegistryId,
  actorActivationIdentity,
  type ActorRegistryEntry,
  type ActorIdentity,
} from "../src/actors/actor-registry";
import {
  activateActor,
  createActorActivationSchema,
} from "../src/actors/actor-activation";
import {
  captureActorExport,
  createActorExportEnvelope,
  importActorExport,
  loadActorExport,
  newActorExportId,
  parseActorExportEnvelope,
  type ActorExportEnvelopeV1,
} from "../src/actors/actor-export";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "../src/placement";
import {
  emptySqliteFixture,
  sqlStorage,
  type TestSqlStorage,
} from "./sqlite-storage";
import type { VariantBy } from "@purin-labs/type-utils";
import type { CountRow } from "../src/actors/sql-rows";

describe("actor export", function actorExportSuite() {
  it(
    "migrates retired columns atomically with import receipts and replays once",
    migratesRetiredImportColumns,
  );
  it("round-trips SQL, KV, alarms, encrypted manifest, and referenced R2 payloads", async function roundTripsState() {
    const source = actorFixture(1);
    const target = actorFixture(2);
    const bucket = new TestR2Bucket();
    const root = testRootSecret();
    const referencedKey =
      "checkpoints/organisation_export_test/session_test/generation-1.bin";
    const referencedBody = new TextEncoder().encode("checkpoint-body");

    source.sql.exec(
      `INSERT INTO sample_state (id, label, payload, nullable_value)
       VALUES (1, 'alpha', ?, NULL)`,
      copyArrayBuffer(referencedBody),
    );
    source.storage.values.set("fault", {
      kind: "rate_limited",
      retryAt: 3_000,
      tags: ["slack", "stream"],
    });
    source.storage.alarmAt = 4_000;
    await bucket.put(referencedKey, referencedBody);

    const captured = await captureActorExport({
      storage: source.storage.durableStorage(),
      bucket: bucket.r2Bucket(),
      root,
      expectedFenceToken: source.fenceToken,
      exportId: newActorExportId(),
      referencedR2Keys: [referencedKey],
      now: 2_000,
    });

    expect(captured.ok).toBe(true);

    if (!captured.ok) {
      throw new Error(captured.error.code);
    }

    const loaded = await loadActorExport({
      bucket: bucket.r2Bucket(),
      root,
      ref: captured.value,
    });

    expect(loaded.ok).toBe(true);

    if (!loaded.ok) {
      throw new Error(loaded.error.code);
    }

    await bucket.delete(referencedKey);
    const imported = await importActorExport({
      storage: target.storage.durableStorage(),
      bucket: bucket.r2Bucket(),
      envelope: loaded.value,
      expectedTargetFenceToken: target.fenceToken,
      now: 2_100,
    });
    const retried = await importActorExport({
      storage: target.storage.durableStorage(),
      bucket: bucket.r2Bucket(),
      envelope: loaded.value,
      expectedTargetFenceToken: target.fenceToken,
      now: 2_200,
    });

    expect(imported).toEqual({ ok: true, value: { stateVersion: 1 } });
    expect(retried).toEqual({ ok: true, value: { stateVersion: 1 } });
    expect(target.storage.alarmAt).toBe(4_000);
    expect(target.storage.values.get("fault")).toEqual({
      kind: "rate_limited",
      retryAt: 3_000,
      tags: ["slack", "stream"],
    });
    expect(
      target.sql
        .exec<SampleRow>(
          `SELECT id, label, payload, nullable_value FROM sample_state`,
        )
        .toArray(),
    ).toEqual([
      {
        id: 1,
        label: "alpha",
        payload: copyArrayBuffer(referencedBody),
        nullable_value: null,
      },
    ]);
    expect(new Uint8Array(await bucket.required(referencedKey))).toEqual(
      referencedBody,
    );
    expect(
      target.sql
        .exec<CountRow>(`SELECT COUNT(*) AS count FROM sample_state`)
        .toArray()[0]?.count,
    ).toBe(1);
  });

  it("rejects a changed checksummed payload", async function rejectsChangedPayload() {
    const fixture = actorFixture(1);
    const payload = await fixturePayload(fixture);
    const envelope = await createActorExportEnvelope(payload);
    const changed: ActorExportEnvelopeV1 = {
      ...envelope,
      payload: {
        ...envelope.payload,
        exportedAt: envelope.payload.exportedAt + 1,
      },
    };
    const parsed = await parseActorExportEnvelope(JSON.stringify(changed));

    expect(parsed).toEqual({
      ok: false,
      error: { code: "export_checksum_mismatch" },
    });
  });

  it("digests the payload independently of its field order", async function digestsIndependentlyOfFieldOrder() {
    const payload = await fixturePayload(actorFixture(1));
    const reordered = Object.fromEntries(
      Object.entries(payload).reverse(),
    ) as typeof payload;

    expect((await createActorExportEnvelope(reordered)).payloadDigestB64).toBe(
      (await createActorExportEnvelope(payload)).payloadDigestB64,
    );
  });

  it("rejects import into a target containing application state", async function rejectsNonEmptyTarget() {
    const source = actorFixture(1);
    const target = actorFixture(2);
    const bucket = new TestR2Bucket();
    const root = testRootSecret();
    source.sql.exec(
      `INSERT INTO sample_state (id, label, payload, nullable_value)
       VALUES (1, 'source', NULL, NULL)`,
    );
    target.sql.exec(
      `INSERT INTO sample_state (id, label, payload, nullable_value)
       VALUES (2, 'target', NULL, NULL)`,
    );
    const captured = await captureActorExport({
      storage: source.storage.durableStorage(),
      bucket: bucket.r2Bucket(),
      root,
      expectedFenceToken: source.fenceToken,
      exportId: newActorExportId(),
      referencedR2Keys: [],
      now: 2_000,
    });

    if (!captured.ok) {
      throw new Error(captured.error.code);
    }

    const loaded = await loadActorExport({
      bucket: bucket.r2Bucket(),
      root,
      ref: captured.value,
    });

    if (!loaded.ok) {
      throw new Error(loaded.error.code);
    }

    const imported = await importActorExport({
      storage: target.storage.durableStorage(),
      bucket: bucket.r2Bucket(),
      envelope: loaded.value,
      expectedTargetFenceToken: target.fenceToken,
      now: 2_100,
    });

    expect(imported).toEqual({
      ok: false,
      error: { code: "target_not_empty", table: "sample_state" },
    });
  });

  it("restores a pre-upgrade export into the current additive schema", async function restoresPreUpgradeExport() {
    const source = versionedActorFixture({
      placementEpoch: 1,
      schemaVersion: 1,
      schema: "legacy",
    });
    const target = versionedActorFixture({
      placementEpoch: 2,
      schemaVersion: 2,
      schema: "current",
    });
    const bucket = new TestR2Bucket();
    const payload = new Uint8Array([0, 1, 2, 127, 128, 255]);

    source.sql.exec(
      `INSERT INTO restored_state (id, label, payload)
       VALUES (1, 'pre-upgrade', ?)`,
      copyArrayBuffer(payload),
    );
    const captured = await captureActorExport({
      storage: source.storage.durableStorage(),
      bucket: bucket.r2Bucket(),
      root: testRootSecret(),
      expectedFenceToken: source.fenceToken,
      exportId: newActorExportId(),
      referencedR2Keys: [],
      now: 3_000,
    });

    if (!captured.ok) {
      throw new Error(captured.error.code);
    }

    const loaded = await loadActorExport({
      bucket: bucket.r2Bucket(),
      root: testRootSecret(),
      ref: captured.value,
    });

    if (!loaded.ok) {
      throw new Error(loaded.error.code);
    }

    const imported = await importActorExport({
      storage: target.storage.durableStorage(),
      bucket: bucket.r2Bucket(),
      envelope: loaded.value,
      expectedTargetFenceToken: target.fenceToken,
      now: 3_100,
    });
    const rows = target.sql
      .exec<RestoredStateRow>(
        `SELECT id, label, payload, current_value FROM restored_state`,
      )
      .toArray();

    expect(imported).toEqual({ ok: true, value: { stateVersion: 1 } });
    expect(loaded.value.payload.source.schemaVersion).toBe(1);
    expect(rows).toEqual([
      {
        id: 1,
        label: "pre-upgrade",
        payload: copyArrayBuffer(payload),
        current_value: "current-default",
      },
    ]);
    expect(
      target.sql
        .exec<CountRow>(`SELECT COUNT(*) AS count FROM restored_state`)
        .toArray()[0]?.count,
    ).toBe(1);
  });
});

type ActorFixture = {
  readonly organisationId: ReturnType<typeof requiredOrganisationId>;
  readonly fenceToken: ReturnType<typeof requiredFenceToken>;
  readonly sql: TestSqlStorage;
  readonly storage: TestDurableObjectStorage;
};

type SampleRow = Record<string, SqlStorageValue> & {
  id: number;
  label: string;
  payload: ArrayBuffer | null;
  nullable_value: string | null;
};

type RestoredStateRow = Record<string, SqlStorageValue> & {
  id: number;
  label: string;
  payload: ArrayBuffer;
  current_value: string;
};

type VersionedFixtureInput =
  | {
      readonly placementEpoch: number;
      readonly schemaVersion: 1;
      readonly schema: "legacy";
    }
  | {
      readonly placementEpoch: number;
      readonly schemaVersion: 2;
      readonly schema: "current";
    };

async function migratesRetiredImportColumns(): Promise<void> {
  const source = actorFixture(1);
  const target = actorFixture(2);
  source.sql.exec("ALTER TABLE sample_state ADD COLUMN retired_label TEXT");
  source.sql.exec(
    "INSERT INTO sample_state (id, label, retired_label) VALUES (1, 'old', 'migrated')",
  );
  const envelope = await createActorExportEnvelope(
    await fixturePayload(source),
  );
  const request = {
    storage: target.storage.durableStorage(),
    bucket: new TestR2Bucket().r2Bucket(),
    envelope,
    expectedTargetFenceToken: target.fenceToken,
    now: 3_000,
  };
  await expect(
    importActorExport({
      ...request,
      sqlMigration: {
        prepare: prepareRetiredLabel,
        complete: failRetiredLabelMigration,
      },
    }),
  ).rejects.toThrow("migration interrupted");
  expect(target.sql.exec("SELECT * FROM sample_state").toArray()).toEqual([]);
  expect(
    target.sql.exec("SELECT * FROM state_object_import").toArray(),
  ).toEqual([]);
  expect(
    target.sql.exec("PRAGMA table_info(sample_state)").toArray(),
  ).not.toContainEqual(expect.objectContaining({ name: "retired_label" }));
  const migration = {
    prepare: prepareRetiredLabel,
    complete: migrateRetiredLabel,
  };
  expect(
    await importActorExport({ ...request, sqlMigration: migration }),
  ).toEqual({ ok: true, value: { stateVersion: 1 } });
  expect(
    await importActorExport({ ...request, sqlMigration: migration }),
  ).toEqual({ ok: true, value: { stateVersion: 1 } });
  expect(
    target.sql.exec("SELECT id, label FROM sample_state").toArray(),
  ).toEqual([{ id: 1, label: "migrated" }]);
  expect(
    target.sql.exec("PRAGMA table_info(sample_state)").toArray(),
  ).not.toContainEqual(expect.objectContaining({ name: "retired_label" }));
}

function prepareRetiredLabel(sql: SqlStorage): void {
  sql.exec("ALTER TABLE sample_state ADD COLUMN retired_label TEXT");
}

function migrateRetiredLabel(sql: SqlStorage): void {
  sql.exec("UPDATE sample_state SET label = retired_label");
  sql.exec("ALTER TABLE sample_state DROP COLUMN retired_label");
}

function failRetiredLabelMigration(sql: SqlStorage): void {
  migrateRetiredLabel(sql);
  throw new Error("migration interrupted");
}

function actorFixture(placementEpoch: number): ActorFixture {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const organisationId = requiredOrganisationId();
  const fenceToken = requiredFenceToken(placementEpoch);
  createActorActivationSchema(sql);
  sql.exec(
    `CREATE TABLE sample_state (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      payload BLOB,
      nullable_value TEXT
    )`,
  );
  const entry = reservedRegistryEntry(
    organisationId,
    fenceToken,
    placementEpoch,
    1,
  );
  const activated = activateActor(sql, actorActivationIdentity(entry, 1_000));

  if (!activated.ok) {
    throw new Error("state object fixture activation failed");
  }

  return {
    organisationId,
    fenceToken,
    sql: fixture.storage,
    storage: new TestDurableObjectStorage(fixture.storage),
  };
}

function versionedActorFixture(input: VersionedFixtureInput): ActorFixture {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const organisationId = requiredOrganisationId();
  const fenceToken = requiredFenceToken(input.placementEpoch);
  createActorActivationSchema(sql);
  sql.exec(
    input.schema === "legacy"
      ? `CREATE TABLE restored_state (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL,
          payload BLOB NOT NULL
        )`
      : `CREATE TABLE restored_state (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL,
          payload BLOB NOT NULL,
          current_value TEXT NOT NULL DEFAULT 'current-default'
        )`,
  );
  const entry = reservedRegistryEntry(
    organisationId,
    fenceToken,
    input.placementEpoch,
    input.schemaVersion,
  );
  const activated = activateActor(sql, actorActivationIdentity(entry, 2_900));

  if (!activated.ok) {
    throw new Error("versioned state object fixture activation failed");
  }

  return {
    organisationId,
    fenceToken,
    sql: fixture.storage,
    storage: new TestDurableObjectStorage(fixture.storage),
  };
}

async function fixturePayload(
  fixture: ActorFixture,
): Promise<ActorExportEnvelopeV1["payload"]> {
  const bucket = new TestR2Bucket();
  const captured = await captureActorExport({
    storage: fixture.storage.durableStorage(),
    bucket: bucket.r2Bucket(),
    root: testRootSecret(),
    expectedFenceToken: fixture.fenceToken,
    exportId: newActorExportId(),
    referencedR2Keys: [],
    now: 2_000,
  });

  if (!captured.ok) {
    throw new Error(captured.error.code);
  }

  const loaded = await loadActorExport({
    bucket: bucket.r2Bucket(),
    root: testRootSecret(),
    ref: captured.value,
  });

  if (!loaded.ok) {
    throw new Error(loaded.error.code);
  }

  return loaded.value.payload;
}

function reservedRegistryEntry(
  organisationId: ReturnType<typeof requiredOrganisationId>,
  fenceToken: ReturnType<typeof requiredFenceToken>,
  placementEpoch: number,
  schemaVersion: number,
): VariantBy<ActorRegistryEntry, "lifecycleStatus", "reserved"> {
  const registryId = parseActorRegistryId(`dor_export_${placementEpoch}`);
  const activationToken = parseActorActivationToken(
    `doa_export_${placementEpoch}`,
  );
  const placement = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });

  if (!registryId.ok || !activationToken.ok || !placement.ok) {
    throw new Error("registry export fixture invariant failed");
  }

  const identity: ActorIdentity = {
    objectKind: "organisation",
    organisationId,
    logicalObjectId: organisationId,
  };

  return {
    registryId: registryId.value,
    activationToken: activationToken.value,
    identity,
    physicalObjectName: `${organisationId}:p${placementEpoch}`,
    placement: placement.value,
    schemaVersion,
    stateVersion: 0,
    fenceToken,
    reservedAt: 900,
    lifecycleStatus: "reserved",
  };
}

function requiredOrganisationId() {
  const parsed = parseOrganisationId("organisation_export_test");
  if (!parsed.ok) throw new Error("organisation fixture invalid");
  return parsed.value;
}

function requiredFenceToken(placementEpoch: number = 1) {
  const parsed = parseActorFenceToken(`dof_export_${placementEpoch}`);
  if (!parsed.ok) throw new Error("fence fixture invalid");
  return parsed.value;
}

function testRootSecret(): SecretsStoreSecret {
  return {
    get: resolveTestRoot,
  } as unknown as SecretsStoreSecret;
}

async function resolveTestRoot(): Promise<string> {
  return Buffer.alloc(32, 7).toString("base64");
}

class TestDurableObjectStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  constructor(readonly sql: TestSqlStorage) {}

  durableStorage(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }

  async list<T>(): Promise<Map<string, T>> {
    return new Map(this.values) as Map<string, T>;
  }

  async put<T>(entries: Map<string, T> | Record<string, T>): Promise<void> {
    const values =
      entries instanceof Map ? entries.entries() : Object.entries(entries);

    for (const [key, value] of values) {
      this.values.set(key, value);
    }
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt =
      scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  transactionSync<T>(closure: () => T): T {
    this.sql.exec("BEGIN");

    try {
      const value = closure();
      this.sql.exec("COMMIT");
      return value;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
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

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async required(key: string): Promise<ArrayBuffer> {
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`missing test R2 object: ${key}`);
    return value;
  }
}

function testR2ObjectBody(value: ArrayBuffer): R2ObjectBody {
  return {
    size: value.byteLength,
    writeHttpMetadata: writeFixtureHttpMetadata,
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

function writeFixtureHttpMetadata(headers: Headers): void {
  headers.set("content-type", "application/octet-stream");
}
