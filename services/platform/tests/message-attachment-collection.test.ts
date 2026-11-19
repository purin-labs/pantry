import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  activateActorRegistryEntry,
  reserveActor,
} from "../src/actors/actor-registry";
import { CASE_ACTOR_SCHEMA_VERSION } from "../src/actors/actor-schema-versions";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "../src/actors/agent-session-schema";
import {
  parseCaseId,
  parseSessionId,
  parseOrganisationId,
  type OrganisationId,
} from "../src/ids";
import {
  ATTACHMENT_COLLECTION_GRACE_MS,
  ATTACHMENT_COLLECTION_INTERVAL_MS,
  attachmentCollectionRecordKey,
  collectOrganisationAttachments,
  runAttachmentCollection,
} from "../src/messages/attachment-collection";
import { parseOrganisationPlacement } from "../src/placement";
import {
  d1Database,
  requireActorExecutionAdmission,
  requireActorRegistryAdmission,
} from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = 1_780_000_000_000;
const OLD = NOW - 2 * ATTACHMENT_COLLECTION_GRACE_MS;
const LIVE = "a".repeat(64);
const DEAD = "b".repeat(64);

/**
 * The scheduled pass deletes only what a complete inventory proves
 * unreachable. These pin the two halves: what counts as complete, and what
 * the pass writes down about itself.
 */
describe("scheduled attachment collection", function collectionSuite() {
  it("deletes what no live actor names and keeps what one does", async function collects() {
    const fixture = await createFixture("organisation_collect_a");
    const caseName = await registerActor(fixture, "case", "case_1", "active");
    const sessionName = await registerActor(
      fixture,
      "session",
      "session_1",
      "active",
    );

    fixture.answers.set(caseName, [
      `attachments/${fixture.organisationId}/slack/${LIVE}`,
    ]);
    fixture.answers.set(sessionName, []);
    fixture.bucket.seed([
      [`attachments/${fixture.organisationId}/slack/${LIVE}`, OLD],
      [
        `attachments/${fixture.organisationId}/derived/${LIVE}/plan37.frames.v1/0.jpg`,
        OLD,
      ],
      [`attachments/${fixture.organisationId}/slack/${DEAD}`, OLD],
      [`attachments/${fixture.organisationId}/staging/abandoned`, OLD],
      [`attachments/${fixture.organisationId}/staging/in-flight`, NOW - 60_000],
    ]);

    const outcome = await collectOrganisationAttachments({
      scope: await requireOrganisationExecutionScope(
        fixture.env,
        fixture.organisationId,
      ),
      archive: fixture.bucket.binding(),
      namespaces: fixture.env,
      now: NOW,
    });

    expect(outcome).toMatchObject({
      kind: "collected",
      receipt: {
        scanned: 5,
        retained: 3,
        deleted: [
          `attachments/${fixture.organisationId}/slack/${DEAD}`,
          `attachments/${fixture.organisationId}/staging/abandoned`,
        ],
      },
    });
  });

  it("skips an organisation whole when one actor is not active or does not answer", async function skipsUnproven() {
    const fixture = await createFixture("organisation_collect_b");
    const active = await registerActor(
      fixture,
      "case",
      "case_active",
      "active",
    );
    await registerActor(fixture, "case", "case_reserved", "reserved");

    fixture.answers.set(active, []);
    fixture.bucket.seed([
      [`attachments/${fixture.organisationId}/slack/${DEAD}`, OLD],
    ]);

    expect(
      await collectOrganisationAttachments({
        scope: await requireOrganisationExecutionScope(
          fixture.env,
          fixture.organisationId,
        ),
        archive: fixture.bucket.binding(),
        namespaces: fixture.env,
        now: NOW,
      }),
    ).toEqual({
      kind: "skipped",
      reason: "actor_not_active",
      actors: ["case_reserved"],
    });

    const silent = await createFixture("organisation_collect_c");
    await registerActor(silent, "session", "session_silent", "active");
    silent.bucket.seed([
      [`attachments/${silent.organisationId}/slack/${DEAD}`, OLD],
    ]);

    expect(
      await collectOrganisationAttachments({
        scope: await requireOrganisationExecutionScope(
          silent.env,
          silent.organisationId,
        ),
        archive: silent.bucket.binding(),
        namespaces: silent.env,
        now: NOW,
      }),
    ).toEqual({
      kind: "skipped",
      reason: "actor_unreachable",
      actors: ["session_silent"],
    });

    // Neither organisation lost an object.
    expect(fixture.bucket.keys()).toEqual([
      `attachments/${fixture.organisationId}/slack/${DEAD}`,
    ]);
    expect(silent.bucket.keys()).toEqual([
      `attachments/${silent.organisationId}/slack/${DEAD}`,
    ]);
  });

  it("ignores a retired actor, whose successor carries its state", async function ignoresRetired() {
    const fixture = await createFixture("organisation_collect_d");
    const successor = await registerActor(
      fixture,
      "case",
      "case_moved",
      "active",
    );
    await registerActor(fixture, "case", "case_old", "retired");
    fixture.answers.set(successor, []);

    expect(
      await collectOrganisationAttachments({
        scope: await requireOrganisationExecutionScope(
          fixture.env,
          fixture.organisationId,
        ),
        archive: fixture.bucket.binding(),
        namespaces: fixture.env,
        now: NOW,
      }),
    ).toMatchObject({ kind: "collected" });
  });

  it("writes a receipt per pass and paces itself by the latest one", async function pacesItself() {
    const fixture = await createFixture("organisation_collect_e");
    const caseName = await registerActor(fixture, "case", "case_1", "active");
    fixture.answers.set(caseName, []);
    fixture.bucket.seed([
      [`attachments/${fixture.organisationId}/slack/${DEAD}`, OLD],
    ]);

    await runAttachmentCollection(fixture.env, NOW);

    const latest = fixture.bucket.json(
      attachmentCollectionRecordKey(fixture.organisationId, "latest"),
    );

    expect(latest).toMatchObject({
      schemaVersion: "plan37.attachment-collection-pass.v1",
      organisationId: fixture.organisationId,
      collectedAt: NOW,
      outcome: {
        kind: "collected",
        receipt: {
          deleted: [`attachments/${fixture.organisationId}/slack/${DEAD}`],
        },
      },
    });
    expect(
      fixture.bucket.json(
        attachmentCollectionRecordKey(fixture.organisationId, NOW),
      ),
    ).toEqual(latest);

    // A second pass inside the interval does not run the organisation again.
    fixture.bucket.seed([
      [`attachments/${fixture.organisationId}/slack/${"c".repeat(64)}`, OLD],
    ]);
    await runAttachmentCollection(fixture.env, NOW + 60_000);
    expect(fixture.bucket.keys()).toContain(
      `attachments/${fixture.organisationId}/slack/${"c".repeat(64)}`,
    );

    // Once the interval has passed, it does.
    await runAttachmentCollection(
      fixture.env,
      NOW + ATTACHMENT_COLLECTION_INTERVAL_MS,
    );
    expect(fixture.bucket.keys()).not.toContain(
      `attachments/${fixture.organisationId}/slack/${"c".repeat(64)}`,
    );
  });

  it("records why an organisation was skipped", async function recordsSkip() {
    const fixture = await createFixture("organisation_collect_f");
    await registerActor(fixture, "case", "case_silent", "active");

    await runAttachmentCollection(fixture.env, NOW);

    expect(
      fixture.bucket.json(
        attachmentCollectionRecordKey(fixture.organisationId, "latest"),
      ),
    ).toMatchObject({
      outcome: {
        kind: "skipped",
        reason: "actor_unreachable",
        actors: ["case_silent"],
      },
    });
  });

  it("persists an uncertain deletion with the confirmed batches", async function recordsUncertainDeletion() {
    const fixture = await createFixture("organisation_collect_g", {
      failDeleteAtCall: 1,
    });
    const caseName = await registerActor(fixture, "case", "case_1", "active");
    fixture.answers.set(caseName, []);
    const keys = Array.from(
      { length: 2_001 },
      function attachmentKey(_, index) {
        return `attachments/${fixture.organisationId}/staging/${String(index).padStart(4, "0")}`;
      },
    );
    fixture.bucket.seed(
      keys.map(function oldObject(key) {
        return [key, OLD] as const;
      }),
    );

    await runAttachmentCollection(fixture.env, NOW);

    expect(
      fixture.bucket.json(
        attachmentCollectionRecordKey(fixture.organisationId, "latest"),
      ),
    ).toMatchObject({
      outcome: {
        kind: "uncertain",
        reason: "attachment_collection_deletion_uncertain",
        receipt: {
          scanned: keys.length,
          retained: 0,
          deleted: keys.slice(0, 1_000),
          uncertain: keys.slice(1_000, 2_000),
          notAttempted: keys.slice(2_000),
          collectedAt: NOW,
        },
      },
    });
    expect(
      fixture.bucket.keys().filter(function attachmentKey(key) {
        return key.startsWith(`attachments/${fixture.organisationId}/`);
      }),
    ).toEqual(keys.slice(1_000));
  });
});

type Fixture = {
  readonly db: SingleDatabase;
  readonly env: UnitTestEnv;
  readonly organisationId: OrganisationId;
  readonly bucket: MemoryBucket;
  readonly answers: Map<string, readonly string[]>;
};

async function createFixture(
  organisationRaw: string,
  options: { readonly failDeleteAtCall?: number } = {},
): Promise<Fixture> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());
  const db = d1Database(sqlite);
  const organisationId = parseOrganisationId(organisationRaw);
  if (!organisationId.ok) throw new Error("organisation fixture invalid");

  sqlite
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Collection', 'beta', 1, 'active')",
    )
    .run(organisationId.value);
  sqlite
    .prepare(
      `INSERT INTO organisation_placement (
       organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint,
       residency_jurisdiction, status, fence_token, created_at, activated_at
     ) VALUES (?, 1, 'affinity', 'multi-region-preview', 'wnam', NULL, 'active', ?, 1, 1)`,
    )
    .run(organisationId.value, `fence-${organisationRaw}`);

  const bucket = new MemoryBucket(options);
  const answers = new Map<string, readonly string[]>();
  const namespace = {
    idFromName(name: string): string {
      return name;
    },
    get(name: string): unknown {
      return {
        async listReachableAttachmentObjectKeys(): Promise<readonly string[]> {
          const keys = answers.get(name);
          if (keys === undefined) throw new Error("actor unreachable");
          return keys;
        },
      };
    },
  };

  return {
    db,
    organisationId: organisationId.value,
    bucket,
    answers,
    env: platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
        databaseBinding: "DB",
        kind: "affinity",
        placementCellId: "multi-region-preview",
        locationHint: "wnam",
      }),
      ARCHIVE: bucket.binding(),
      CASE: namespace,
      SESSION: namespace,
    }),
  };
}

async function registerActor(
  fixture: Fixture,
  kind: "case" | "session",
  idRaw: string,
  lifecycle: "reserved" | "active" | "retired",
): Promise<string> {
  const placement = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });
  const id = kind === "case" ? parseCaseId(idRaw) : parseSessionId(idRaw);
  if (!placement.ok || !id.ok) throw new Error("actor fixture invalid");

  const reserved = await reserveActor({
    db: fixture.db,
    identity:
      kind === "case"
        ? {
            objectKind: "case",
            organisationId: fixture.organisationId,
            logicalObjectId: id.value as never,
          }
        : {
            objectKind: "session",
            organisationId: fixture.organisationId,
            logicalObjectId: id.value as never,
          },
    admission: await requireActorExecutionAdmission(
      fixture.db,
      (kind === "case"
        ? {
            objectKind: "case",
            organisationId: fixture.organisationId,
            logicalObjectId: id.value as never,
          }
        : {
            objectKind: "session",
            organisationId: fixture.organisationId,
            logicalObjectId: id.value as never,
          }
      ).organisationId,
      placement.value,
    ),
    schemaVersion:
      kind === "case"
        ? CASE_ACTOR_SCHEMA_VERSION
        : CANONICAL_SESSION_SCHEMA_VERSION,
    now: 1,
  });
  if (!reserved.ok) throw new Error(reserved.error.code);

  if (lifecycle !== "reserved") {
    const activated = await activateActorRegistryEntry({
      db: fixture.db,
      admission: await requireActorRegistryAdmission(
        fixture.db,
        reserved.value.registryId,
      ),
      registryId: reserved.value.registryId,
      activationToken: reserved.value.activationToken,
      stateVersion: 1,
      now: 2,
    });
    if (!activated.ok) throw new Error(activated.error.code);
  }
  if (lifecycle === "retired") {
    await fixture.db
      .prepare(
        `UPDATE durable_object_registry
         SET lifecycle_status = 'retired', exporting_at = 3, retired_at = 4
         WHERE registry_id = ?`,
      )
      .bind(reserved.value.registryId)
      .run();
  }

  return reserved.value.physicalObjectName;
}

class MemoryBucket {
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; uploaded: number }
  >();
  private deleteCalls = 0;

  constructor(
    private readonly options: { readonly failDeleteAtCall?: number } = {},
  ) {}

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  seed(entries: readonly (readonly [string, number])[]): void {
    for (const [key, uploaded] of entries) {
      this.objects.set(key, { bytes: new Uint8Array([1]), uploaded });
    }
  }

  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  json(key: string): unknown {
    const stored = this.objects.get(key);
    return stored === undefined
      ? null
      : JSON.parse(new TextDecoder().decode(stored.bytes));
  }

  async list(input: { readonly prefix: string }): Promise<unknown> {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(input.prefix))
        .map(([key, value]) => ({ key, uploaded: new Date(value.uploaded) })),
      truncated: false,
    };
  }

  async get(key: string): Promise<unknown> {
    const stored = this.objects.get(key);
    return stored === undefined
      ? null
      : { text: async () => new TextDecoder().decode(stored.bytes) };
  }

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.objects.set(key, {
      bytes:
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      uploaded: Date.now(),
    });
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (this.deleteCalls === this.options.failDeleteAtCall) {
      this.deleteCalls += 1;
      throw new Error("delete unavailable");
    }

    this.deleteCalls += 1;

    for (const key of keys) this.objects.delete(key);
  }
}
