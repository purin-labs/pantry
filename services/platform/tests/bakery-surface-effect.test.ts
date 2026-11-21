/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import {
  bakeryEffectDeliveryTarget,
  createBakerySurfaceAttachment,
  createBakerySurfaceEffect,
  createBakerySurfaceReceipt,
  type BakerySurfaceEffectV1,
  type BakerySurfaceCommandV1,
} from "@purin-labs/bakery-model/bakery-surface";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(function authorityFixture() {
  return { valid: true };
});

vi.mock(
  "../src/actors/agent-session-harness-authority",
  async function harnessAuthorityMock(
    importOriginal: () => Promise<
      typeof import("../src/actors/agent-session-harness-authority")
    >,
  ) {
    const actual = await importOriginal();
    return {
      ...actual,
      parsePersistedHarnessTurnLease(value: unknown) {
        return value;
      },
      preflightHarnessTurnLease(
        _storage: DurableObjectStorage,
        lease: HarnessTurnLease,
      ) {
        return authority.valid
          ? { ok: true, value: lease }
          : { ok: false, error: { code: "harness_lease_cancelled" } };
      },
      preflightHarnessTurnLeaseInTransaction(
        _sql: SqlStorage,
        lease: HarnessTurnLease,
      ) {
        return authority.valid
          ? { ok: true, value: lease }
          : { ok: false, error: { code: "harness_lease_cancelled" } };
      },
    };
  },
);

import { initializeAgentSessionPersistence } from "../src/actors/agent-session-schema";
import {
  dispatchBakerySurfaceEffect,
  listBakerySurfaceTimelineEvents,
  reconcileBakerySurfaceEffects,
  settleBakerySurfaceEffect,
} from "../src/actors/bakery-surface-effect";
import { parseOrganisationId, type OrganisationId } from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { SqliteD1Database, type SqliteD1Statement } from "./sqlite-d1";

const baseline = singleDatabaseSchema();

describe("Kitchen surface effect lifecycle", function surfaceEffectSuite() {
  beforeEach(function resetAuthority() {
    authority.valid = true;
  });

  it("recovers publication after persistence survives an interrupted delivery", async function recoversPublication() {
    const fixture = lifecycleFixture();
    fixture.db.failNextBatch();

    await expect(
      dispatchBakerySurfaceEffect(await dispatchInput(fixture, 100)),
    ).rejects.toThrow("injected_d1_batch_failure");
    expect(fixture.outbox()).toMatchObject({
      state_kind: "dispatching",
      state_projection: JSON.stringify({
        kind: "surface_dispatching",
        publication: "pending",
      }),
    });
    expect(fixture.delivery()).toBeUndefined();

    const restarted = fixture.restartActor();
    await reconcileBakerySurfaceEffects({
      db: fixture.db,
      storage: restarted,
      now: 101,
    });

    expect(fixture.delivery()).toMatchObject({ state_kind: "dispatching" });
    expect(fixture.timelineKinds()).toEqual(["started"]);
    expect(fixture.outbox()).toMatchObject({
      state_projection: JSON.stringify({
        kind: "surface_dispatching",
        publication: "published",
      }),
    });
    fixture.close();
  });

  it("advances bounded recovery beyond a full page of completed effects", async function advancesRecoveryPage() {
    const fixture = lifecycleFixture("recovery-page");
    for (let index = 0; index < 32; index += 1) {
      const effect = await testSurfaceEffect(`completed_${index}`, 30_000);
      const receipt = await rejectedSurfaceReceipt(
        effect,
        `Completed effect ${index}`,
      );
      fixture.seedOutbox({
        effect,
        requestId: `request_completed_${index}`,
        stateKind: "settled",
        stateProjection: {
          kind: "surface_settled",
          receipt,
          settledAt: 100 + index,
        },
        updatedAt: index + 1,
      });
    }
    const pending = await testSurfaceEffect("pending_33", 150);
    fixture.seedOutbox({
      effect: pending,
      requestId: "request_pending_33",
      stateKind: "dispatching",
      stateProjection: {
        kind: "surface_dispatching",
        publication: "pending",
      },
      updatedAt: 100,
    });

    await reconcileBakerySurfaceEffects({
      db: fixture.db,
      storage: fixture.storage,
      now: 200,
    });
    expect(fixture.outboxByEffectId(pending.effectId)).toMatchObject({
      state_kind: "dispatching",
    });
    expect(fixture.outboxStateCounts()).toEqual([
      { state_kind: "dispatching", count: 1 },
      { state_kind: "reconciled", count: 32 },
    ]);

    await reconcileBakerySurfaceEffects({
      db: fixture.db,
      storage: fixture.storage,
      now: 201,
    });
    expect(fixture.outboxByEffectId(pending.effectId)).toMatchObject({
      state_kind: "reconciled",
    });
    expect(fixture.deliveryByEffectId(pending.effectId)).toMatchObject({
      state_kind: "settled",
    });
    fixture.close();
  });

  it("repairs D1 from the canonical Actor receipt on an idempotent retry", async function repairsProjection() {
    const fixture = lifecycleFixture();
    const effect = await persistedAndPublishedEffect(fixture);
    const receipt = await createBakerySurfaceReceipt(effect, {
      kind: "completed",
      result: {
        kind: "rejected",
        command: "inspect_surface",
        code: "stale_surface",
        message: "The surface epoch changed.",
      },
    });
    fixture.db.failNextBatch();

    expect(
      await settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.storage,
        organisationId: fixture.organisationId,
        receipt,
        now: clockAt(200),
      }),
    ).toEqual({ ok: true, kind: "accepted" });
    expect(fixture.outbox()).toMatchObject({ state_kind: "settled" });
    expect(fixture.delivery()).toMatchObject({ state_kind: "dispatching" });

    expect(
      await settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.restartActor(),
        organisationId: fixture.organisationId,
        receipt,
        now: clockAt(201),
      }),
    ).toEqual({ ok: true, kind: "duplicate" });
    expect(fixture.delivery()).toEqual(
      expect.objectContaining({
        state_kind: "settled",
        receipt_json: JSON.stringify(receipt),
      }),
    );
    expect(fixture.timelineKinds()).toEqual(["started", "settled"]);
    fixture.close();
  });

  it("commits and projects only one concurrent conflicting receipt", async function serializesConflictingSettlements() {
    const fixture = lifecycleFixture("concurrent");
    const effect = await persistedAndPublishedEffect(fixture);
    const firstReceipt = await rejectedSurfaceReceipt(
      effect,
      "First result",
    );
    const secondReceipt = await rejectedSurfaceReceipt(
      effect,
      "Second result",
    );

    const results = await Promise.all([
      settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.storage,
        organisationId: fixture.organisationId,
        receipt: firstReceipt,
        now: clockAt(200),
      }),
      settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.storage,
        organisationId: fixture.organisationId,
        receipt: secondReceipt,
        now: clockAt(200),
      }),
    ]);

    expect(results.filter(isAcceptedSettlement)).toHaveLength(1);
    expect(results.filter(isConflictSettlement)).toHaveLength(1);
    const acceptedIndex = results.findIndex(isAcceptedSettlement);
    const receipts = [firstReceipt, secondReceipt] as const;
    if (acceptedIndex < 0) throw new Error("accepted settlement missing");
    expect(fixture.actorReceiptJson(effect.effectId)).toBe(
      JSON.stringify(receipts[acceptedIndex]),
    );
    expect(fixture.actorReceiptJson(effect.effectId)).toBe(
      fixture.deliveryReceiptJson(effect.effectId),
    );
    fixture.close();
  });

  it("persists the time observed inside the settlement transaction", async function persistsCommitTime() {
    const fixture = lifecycleFixture("commit-time");
    const effect = await persistedAndPublishedEffect(fixture);
    const receipt = await rejectedSurfaceReceipt(
      effect,
      "Validated result",
    );
    const clock = new SequenceClock([200, 250]);

    expect(
      await settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.storage,
        organisationId: fixture.organisationId,
        receipt,
        now: clock.read.bind(clock),
      }),
    ).toEqual({ ok: true, kind: "accepted" });
    expect(fixture.outbox()).toMatchObject({
      state_kind: "reconciled",
      state_projection: JSON.stringify({
        kind: "surface_settled",
        receipt,
        settledAt: 250,
      }),
    });
    expect(fixture.delivery()).toMatchObject({
      state_kind: "settled",
      updated_at: 250,
    });
    fixture.close();
  });

  it("rejects a receipt whose validation crosses the effect deadline", async function rejectsValidationPastDeadline() {
    const fixture = lifecycleFixture("deadline-crossing");
    const effect = await persistedAndPublishedEffect(fixture);
    const receipt = await rejectedSurfaceReceipt(effect, "Late result");
    const clock = new SequenceClock([200, effect.deadlineAt]);

    expect(
      await settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.storage,
        organisationId: fixture.organisationId,
        receipt,
        now: clock.read.bind(clock),
      }),
    ).toEqual({ ok: false, code: "surface_effect_expired" });
    expect(fixture.outbox()).toMatchObject({ state_kind: "dispatching" });
    expect(fixture.delivery()).toMatchObject({ state_kind: "dispatching" });
    fixture.close();
  });

  it("rejects correctly hashed receipts for another command or surface", async function validatesStoredCommand() {
    const commandFixture = lifecycleFixture("command");
    const commandEffect = await persistedAndPublishedEffect(commandFixture);
    const anotherCommand = await createBakerySurfaceReceipt(commandEffect, {
      kind: "completed",
      result: {
        kind: "rejected",
        command: "set_view",
        code: "stale_surface",
        message: "The surface epoch changed.",
      },
    });
    expect(
      await settleBakerySurfaceEffect({
        db: commandFixture.db,
        storage: commandFixture.storage,
        organisationId: commandFixture.organisationId,
        receipt: anotherCommand,
        now: clockAt(200),
      }),
    ).toEqual({ ok: false, code: "surface_effect_receipt_invalid" });
    commandFixture.close();

    const surfaceFixture = lifecycleFixture("surface");
    const surfaceEffect = await persistedAndPublishedEffect(surfaceFixture);
    const anotherSurface = await createBakerySurfaceReceipt(surfaceEffect, {
      kind: "completed",
      result: {
        kind: "succeeded",
        command: "inspect_surface",
        surface: await createBakerySurfaceAttachment(
          surfaceContext("another-surface", 9),
        ),
        output: { kind: "surface" },
      },
    });
    expect(
      await settleBakerySurfaceEffect({
        db: surfaceFixture.db,
        storage: surfaceFixture.storage,
        organisationId: surfaceFixture.organisationId,
        receipt: anotherSurface,
        now: clockAt(200),
      }),
    ).toEqual({ ok: false, code: "surface_effect_receipt_invalid" });
    surfaceFixture.close();
  });

  it("settles a rehearsal edit only with its plan change on the next epoch", async function validatesRehearsalEdit() {
    const fixture = lifecycleFixture("rehearsal-edit");
    const effect = await persistedAndPublishedEffect(fixture, {
      schemaVersion: 1,
      kind: "edit_rehearsal",
      target: { surfaceSessionId: "surface_test", surfaceEpoch: 2 },
      planFingerprint: "plan_before",
      edit: { kind: "set_baker", batchId: "B", baker: 2 },
    });
    async function settle(
      epoch: number,
      fingerprint: string,
      baker: number,
    ) {
      const receipt = await createBakerySurfaceReceipt(effect, {
        kind: "completed",
        result: {
          kind: "succeeded",
          command: "edit_rehearsal",
          surface: await createBakerySurfaceAttachment(
            scheduledContext(epoch, fingerprint, baker),
          ),
          output: { kind: "surface" },
        },
      });
      return settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.storage,
        organisationId: fixture.organisationId,
        receipt,
        now: clockAt(200),
      });
    }
    const invalid = { ok: false, code: "surface_effect_receipt_invalid" };
    expect(await settle(2, "plan_after", 2)).toEqual(invalid);
    expect(await settle(3, "plan_before", 2)).toEqual(invalid);
    expect(await settle(3, "plan_after", 1)).toEqual(invalid);
    expect(await settle(3, "plan_after", 2)).toMatchObject({ ok: true });
    fixture.close();
  });

  it("settles production draft edits on their epoch and an apply on the next", async function validatesProductionAuthoring() {
    const invalid = { ok: false, code: "surface_effect_receipt_invalid" };
    const before = "a".repeat(64);
    const after = "b".repeat(64);
    async function settle(
      fixture: ReturnType<typeof lifecycleFixture>,
      effect: Awaited<ReturnType<typeof persistedAndPublishedEffect>>,
      context: ReturnType<typeof productionContext>,
    ) {
      const receipt = await createBakerySurfaceReceipt(effect, {
        kind: "completed",
        result: {
          kind: "succeeded",
          command: effect.command.kind as "edit_production",
          surface: await createBakerySurfaceAttachment(context),
          output: { kind: "surface" },
        },
      });
      return settleBakerySurfaceEffect({
        db: fixture.db,
        storage: fixture.storage,
        organisationId: fixture.organisationId,
        receipt,
        now: clockAt(200),
      });
    }

    const editing = lifecycleFixture("production-edit");
    const edit = await persistedAndPublishedEffect(editing, {
      schemaVersion: 1,
      kind: "edit_production",
      target: { surfaceSessionId: "surface_test", surfaceEpoch: 2 },
      draftDigest: before,
      edit: { kind: "set_baker", batchId: "A", tray: 1, baker: 2 },
    });
    // The draft must change, show the edit and keep the run's epoch.
    expect(
      await settle(
        editing,
        edit,
        productionContext(2, "plan", before, 2, null),
      ),
    ).toEqual(invalid);
    expect(
      await settle(
        editing,
        edit,
        productionContext(2, "plan", after, 1, null),
      ),
    ).toEqual(invalid);
    expect(
      await settle(
        editing,
        edit,
        productionContext(3, "plan", after, 2, null),
      ),
    ).toEqual(invalid);
    expect(
      await settle(
        editing,
        edit,
        productionContext(2, "plan", after, 2, null),
      ),
    ).toMatchObject({ ok: true });
    editing.close();

    const applying = lifecycleFixture("production-apply");
    const apply = await persistedAndPublishedEffect(applying, {
      schemaVersion: 1,
      kind: "apply_production",
      target: { surfaceSessionId: "surface_test", surfaceEpoch: 2 },
      draftDigest: before,
      planFingerprint: "plan_preview",
    });
    // The previewed run starts on the next epoch.
    expect(
      await settle(
        applying,
        apply,
        productionContext(2, "plan_preview", after, 1, "plan_preview"),
      ),
    ).toEqual(invalid);
    expect(
      await settle(
        applying,
        apply,
        productionContext(3, "plan_before", after, 1, "plan_preview"),
      ),
    ).toEqual(invalid);
    expect(
      await settle(
        applying,
        apply,
        productionContext(3, "plan_preview", after, 1, "plan_preview"),
      ),
    ).toMatchObject({ ok: true });
    applying.close();
  });

  it("marks cancelled dispatched work indeterminate and rejects late success", async function reconcilesTerminalDispatch() {
    const cancelled = lifecycleFixture("cancelled");
    await persistedAndPublishedEffect(cancelled);
    authority.valid = false;
    await reconcileBakerySurfaceEffects({
      db: cancelled.db,
      storage: cancelled.restartActor(),
      now: 200,
    });
    expect(cancelled.outbox()).toMatchObject({ state_kind: "reconciled" });
    expect(cancelled.delivery()).toMatchObject({
      state_kind: "indeterminate",
    });
    expect(cancelled.timelineKinds()).toEqual(["started", "indeterminate"]);
    cancelled.close();

    authority.valid = true;
    const expired = lifecycleFixture("expired");
    const effect = await persistedAndPublishedEffect(expired);
    const receipt = await createBakerySurfaceReceipt(effect, {
      kind: "completed",
      result: {
        kind: "rejected",
        command: "inspect_surface",
        code: "stale_surface",
        message: "The surface epoch changed.",
      },
    });
    expect(
      await settleBakerySurfaceEffect({
        db: expired.db,
        storage: expired.storage,
        organisationId: expired.organisationId,
        receipt,
        now: clockAt(effect.deadlineAt),
      }),
    ).toEqual({ ok: false, code: "surface_effect_expired" });
    expired.close();
  });

  it("reads more than sixteen timeline effects incrementally with original identities", async function readsTimelineCursor() {
    const fixture = lifecycleFixture("timeline");
    for (let index = 0; index < 18; index += 1) {
      const effect = await createBakerySurfaceEffect({
        effectId: `effect_timeline_${index}`,
        dispatchId: `dispatch_timeline_${index}`,
        deadlineAt: 30_000,
        command: {
          schemaVersion: 1,
          kind: "inspect_surface",
          target: { surfaceSessionId: "surface_test", surfaceEpoch: 2 },
        },
      });
      const requestId = `request_timeline_${Math.floor(index / 6)}`;
      const turnId = `turn_timeline_${Math.floor(index / 6)}`;
      const indeterminate = index === 17;
      const receipt = indeterminate
        ? null
        : await createBakerySurfaceReceipt(effect, {
            kind: "completed",
            result: {
              kind: "rejected",
              command: "inspect_surface",
              code: "stale_surface",
              message: "The surface epoch changed.",
            },
          });
      fixture.db.database
        .prepare(
          `INSERT INTO bakery_surface_effect_delivery (
             effect_id, organisation_id, user_id, session_id, turn_id,
             request_id, surface_session_id, surface_epoch, command_digest,
             effect_json, state_kind, receipt_json, deadline_at, created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          effect.effectId,
          fixture.organisationId,
          "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
          "session_timeline",
          turnId,
          requestId,
          bakeryEffectDeliveryTarget(effect).surfaceSessionId,
          bakeryEffectDeliveryTarget(effect).surfaceEpoch,
          effect.commandDigest,
          JSON.stringify(effect),
          indeterminate ? "indeterminate" : "settled",
          receipt === null ? null : JSON.stringify(receipt),
          effect.deadlineAt,
          100 + index,
          200 + index,
        );
      fixture.db.database
        .prepare(
          `INSERT INTO bakery_surface_timeline_event (
             organisation_id, user_id, session_id, turn_id, request_id,
             effect_id, event_kind, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?),
                    (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fixture.organisationId,
          "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
          "session_timeline",
          turnId,
          requestId,
          effect.effectId,
          100 + index,
          fixture.organisationId,
          "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
          "session_timeline",
          turnId,
          requestId,
          effect.effectId,
          indeterminate ? "indeterminate" : "settled",
          200 + index,
        );
    }

    const events = await listBakerySurfaceTimelineEvents({
      db: fixture.db,
      organisationId: fixture.organisationId,
      userId: "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
      requestIds: [
        "request_timeline_0",
        "request_timeline_1",
        "request_timeline_2",
      ],
      afterSequence: 0,
    });
    expect(events).toHaveLength(36);
    expect(new Set(events.map(readRequestId))).toEqual(
      new Set([
        "request_timeline_0",
        "request_timeline_1",
        "request_timeline_2",
      ]),
    );
    expect(events.filter(isIndeterminateEvent)).toHaveLength(1);
    const cursor = events.at(-1)?.sequence;
    if (cursor === undefined) throw new Error("timeline cursor missing");
    expect(
      await listBakerySurfaceTimelineEvents({
        db: fixture.db,
        organisationId: fixture.organisationId,
        userId: "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
        requestIds: [
          "request_timeline_0",
          "request_timeline_1",
          "request_timeline_2",
        ],
        afterSequence: cursor,
      }),
    ).toEqual([]);
    fixture.close();
  });
});

async function persistedAndPublishedEffect(
  fixture: LifecycleFixture,
  command?: BakerySurfaceCommandV1,
): Promise<BakerySurfaceEffectV1> {
  fixture.db.failNextBatch();
  await expect(
    dispatchBakerySurfaceEffect(await dispatchInput(fixture, 100, command)),
  ).rejects.toThrow("injected_d1_batch_failure");
  await reconcileBakerySurfaceEffects({
    db: fixture.db,
    storage: fixture.restartActor(),
    now: 101,
  });
  const raw = fixture.delivery()?.effect_json;
  if (typeof raw !== "string") throw new Error("surface effect missing");
  return JSON.parse(raw) as BakerySurfaceEffectV1;
}

async function testSurfaceEffect(
  suffix: string,
  deadlineAt: number,
): Promise<BakerySurfaceEffectV1> {
  return createBakerySurfaceEffect({
    effectId: `effect_${suffix}`,
    dispatchId: `dispatch_${suffix}`,
    deadlineAt,
    command: {
      schemaVersion: 1,
      kind: "inspect_surface",
      target: { surfaceSessionId: "surface_test", surfaceEpoch: 2 },
    },
  });
}

async function rejectedSurfaceReceipt(
  effect: BakerySurfaceEffectV1,
  message: string,
) {
  return createBakerySurfaceReceipt(effect, {
    kind: "completed",
    result: {
      kind: "rejected",
      command: "inspect_surface",
      code: "stale_surface",
      message,
    },
  });
}

async function dispatchInput(
  fixture: LifecycleFixture,
  now: number,
  command: BakerySurfaceCommandV1 = {
    schemaVersion: 1,
    kind: "inspect_surface",
    target: { surfaceSessionId: "surface_test", surfaceEpoch: 2 },
  },
) {
  return {
    db: fixture.db as SingleDatabase,
    storage: fixture.storage,
    organisationId: fixture.organisationId,
    sessionId: fixture.lease.session.sessionId,
    requestId: `request_${fixture.suffix}`,
    userId: "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
    lease: fixture.lease,
    callId: `call_${fixture.suffix}`,
    command,
    now,
  };
}

type LifecycleFixture = ReturnType<typeof lifecycleFixture>;

function lifecycleFixture(suffix = "recovery") {
  const organisation = parseOrganisationId("organisation_surface_effect_test");
  if (!organisation.ok) throw new Error(organisation.error.code);
  const local = emptySqliteFixture();
  const sql = sqlStorage(local.storage);
  initializeAgentSessionPersistence(sql);
  const database = new DatabaseSync(":memory:");
  database.exec(baseline);
  database.exec(`
    INSERT INTO organisation (organisation_id, organisation_handle, name, created_at)
    VALUES ('organisation_surface_effect_test', 'surface-effect', 'Surface effect', 1);
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES (
      'user_d82263db-e84e-5118-9b60-e797a85f0ae5', 'test', 'surface',
      'surface@example.com', 'Surface operator', 1, 1, 1
    );
  `);
  // The fake holds both schemas, as every unit test database does.
  const db = new FailingD1Database(database) as FailingD1Database &
    SingleDatabase;
  const lease = surfaceLease(organisation.value, suffix);
  const storage = new SurfaceStorage(local.storage).binding();
  return {
    suffix,
    organisationId: organisation.value,
    lease,
    db,
    storage,
    restartActor() {
      return new SurfaceStorage(local.storage).binding();
    },
    outbox() {
      return local.database
        .prepare(
          `SELECT state_kind, state_projection
           FROM actor_outbox WHERE originating_event_id = ?`,
        )
        .get(`surface:${lease.turn.turnId}:call_${suffix}`);
    },
    outboxByEffectId(effectId: string) {
      return local.database
        .prepare(
          `SELECT state_kind, state_projection
           FROM actor_outbox WHERE effect_id = ?`,
        )
        .get(effectId);
    },
    outboxStateCounts() {
      return local.database
        .prepare(
          `SELECT state_kind, COUNT(*) AS count
           FROM actor_outbox GROUP BY state_kind ORDER BY state_kind`,
        )
        .all();
    },
    seedOutbox(input: {
      readonly effect: BakerySurfaceEffectV1;
      readonly requestId: string;
      readonly stateKind: "dispatching" | "settled";
      readonly stateProjection: unknown;
      readonly updatedAt: number;
    }) {
      const request = {
        kind: "bakery_surface_effect.v1",
        organisationId: organisation.value,
        sessionId: lease.session.sessionId,
        turnId: lease.turn.turnId,
        requestId: input.requestId,
        callId: `call_${input.requestId}`,
        userId: "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
        lease,
        effect: input.effect,
      };
      local.database
        .prepare(
          `INSERT INTO actor_outbox (
             effect_id, organisation_id, originating_event_id, request_envelope,
             state_kind, state_projection, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.effect.effectId,
          organisation.value,
          `surface:${lease.turn.turnId}:${request.callId}`,
          JSON.stringify(request),
          input.stateKind,
          JSON.stringify(input.stateProjection),
          input.updatedAt,
        );
    },
    delivery() {
      return database
        .prepare(
          `SELECT state_kind, receipt_json, effect_json, updated_at
           FROM bakery_surface_effect_delivery WHERE request_id = ?`,
        )
        .get(`request_${suffix}`);
    },
    deliveryByEffectId(effectId: string) {
      return database
        .prepare(
          `SELECT state_kind, receipt_json, effect_json
           FROM bakery_surface_effect_delivery WHERE effect_id = ?`,
        )
        .get(effectId);
    },
    actorReceiptJson(effectId: string) {
      const row = local.database
        .prepare(
          `SELECT json_extract(state_projection, '$.receipt') AS receipt_json
           FROM actor_outbox WHERE effect_id = ?`,
        )
        .get(effectId);
      return requiredTextColumn(row, "receipt_json");
    },
    deliveryReceiptJson(effectId: string) {
      const row = database
        .prepare(
          `SELECT receipt_json FROM bakery_surface_effect_delivery
           WHERE effect_id = ?`,
        )
        .get(effectId);
      return requiredTextColumn(row, "receipt_json");
    },
    timelineKinds() {
      return database
        .prepare(
          `SELECT event_kind FROM bakery_surface_timeline_event
           WHERE request_id = ? ORDER BY sequence`,
        )
        .all(`request_${suffix}`)
        .map(readEventKind);
    },
    close() {
      database.close();
      local.database.close();
    },
  };
}

function surfaceLease(
  organisationId: OrganisationId,
  suffix: string,
): HarnessTurnLease {
  return {
    leaseId: `lease_${suffix}`,
    session: {
      organisationId,
      sessionId: `session_${suffix}`,
      streamId: `stream_${suffix}`,
    },
    turn: {
      turnId: `turn_${suffix}`,
      inputId: `input_${suffix}`,
      turnLeaseGeneration: 1,
      budgetRevision: `budget_${suffix}`,
    },
    runtimeLease: { generation: 1, leaseId: `runtime_${suffix}` },
    runtimeRevision: `runtime_revision_${suffix}`,
    requestAuthority: {
      kind: "control",
      organisationId,
      requesterPersonId: "person_surface_effect_test",
      userId: "user_d82263db-e84e-5118-9b60-e797a85f0ae5",
      membershipRevision: 1,
      role: "owner",
    },
    authorityPartitionDigest: "a".repeat(64),
    issuedAt: 100,
    expiresAt: 30_000,
  };
}

function surfaceContext(surfaceSessionId: string, surfaceEpoch: number) {
  return {
    schemaVersion: 1 as const,
    kind: "bakery-workspace" as const,
    runOpenReview: null,
    surfaceSessionId,
    surfaceEpoch,
    capturedAt: 150,
    comparison: null,
    simulation: null,
    supportedCommands: ["inspect_surface"] as const,
    active: {
      kind: "production" as const,
      view: { camera: "perspective" as const },
      pendingOperation: null,
      panel: "workflow" as const,
      readiness: "loading" as const,
      planFingerprint: null,
      variant: null,
      operationCount: 0 as const,
      operations: [] as const,
      selection: null,
      playback: null,
      candidate: null,
      scenarioSaveProposal: null,
      draft: null,
    },
  };
}

function scheduledContext(
  surfaceEpoch: number,
  planFingerprint: string,
  bakerB: number,
) {
  return {
    schemaVersion: 1 as const,
    kind: "bakery-workspace" as const,
    runOpenReview: null,
    surfaceSessionId: "surface_test",
    surfaceEpoch,
    capturedAt: 150,
    comparison: null,
    simulation: null,
    supportedCommands: ["inspect_surface", "edit_rehearsal"] as const,
    active: {
      kind: "rehearsal" as const,
      view: { camera: "perspective" as const },
      rehearsalKind: "scheduled" as const,
      panel: "workflow" as const,
      faults: { outage: null, failure: null, recovery: null },
      editReview: null,
      rackLayout: null,
      readiness: "ready" as const,
      selection: null,
      playback: {
        cursorSeconds: 0,
        playback: "paused" as const,
        speed: 120,
      },
      runId: null,
      attemptId: null,
      planFingerprint,
      pendingOperation: null,
      tasks: [],
      resources: [],
      trays: [
        {
          batchId: "A",
          cellId: "cold-cell-1" as const,
          baker: 1,
          dependsOn: [],
          earliestStartSeconds: 0,
        },
        {
          batchId: "B",
          cellId: "cold-cell-1" as const,
          baker: bakerB,
          dependsOn: [],
          earliestStartSeconds: 0,
        },
      ],
      bakerCount: 2,
      candidate: null,
      runSaveProposal: null,
    },
  };
}

function productionContext(
  surfaceEpoch: number,
  planFingerprint: string,
  digest: string,
  bakerA: number,
  preview: string | null,
) {
  return {
    schemaVersion: 1 as const,
    kind: "bakery-workspace" as const,
    runOpenReview: null,
    surfaceSessionId: "surface_test",
    surfaceEpoch,
    capturedAt: 150,
    comparison: null,
    simulation: null,
    supportedCommands: ["inspect_surface", "edit_production"] as const,
    active: {
      kind: "production" as const,
      view: { camera: "perspective" as const },
      pendingOperation: null,
      panel: "workflow" as const,
      readiness: "ready" as const,
      planFingerprint,
      variant: "normal" as const,
      operationCount: 1,
      operations: [
        {
          id: "batch:A:native:1",
          label: "Batch A, tray 1",
          state: "awaiting-evidence",
        },
      ],
      selection: { kind: "batch" as const, id: "A", label: "batch A" },
      playback: {
        cursorSeconds: 0,
        playback: "paused" as const,
        speed: 120,
      },
      candidate: null,
      scenarioSaveProposal: null,
      draft: {
        replacement: null,
        digest,
        batchCount: 1,
        traysPerBatch: 1,
        bakerCount: 2,
        variant: "normal" as const,
        assignments: [
          {
            batchId: "A",
            tray: 1,
            baker: bakerA,
            dependsOn: [],
            earliestStartSeconds: 0,
          },
        ],
        manualTasks: [],
        preview:
          preview === null
            ? null
            : {
                planFingerprint: preview,
                operationCount: 1,
                run: {
                  state: "complete" as const,
                  endSeconds: 100,
                  lateBatches: 0,
                  unfinishedBatches: 0,
                },
              },
      },
    },
  };
}

function readEventKind(row: Record<string, unknown>): unknown {
  return row.event_kind;
}

function readRequestId(event: { readonly requestId: string }): string {
  return event.requestId;
}

function isIndeterminateEvent(event: {
  readonly terminal: { readonly kind: string };
}): boolean {
  return event.terminal.kind === "indeterminate";
}

function isAcceptedSettlement(result: {
  readonly ok: boolean;
  readonly kind?: string;
}): boolean {
  return result.ok && result.kind === "accepted";
}

function isConflictSettlement(result: {
  readonly ok: boolean;
  readonly code?: string;
}): boolean {
  return !result.ok && result.code === "surface_effect_conflict";
}

function requiredTextColumn(
  row: Readonly<Record<string, unknown>> | undefined,
  column: string,
): string {
  const value = row?.[column];
  if (typeof value !== "string") throw new Error(`missing ${column}`);
  return value;
}

function clockAt(value: number): () => number {
  return readClockAt.bind(null, value);
}

function readClockAt(value: number): number {
  return value;
}

class SequenceClock {
  private index = 0;

  constructor(private readonly values: readonly number[]) {
    if (values.length === 0) throw new Error("clock sequence is empty");
  }

  read(): number {
    const value = this.values[Math.min(this.index, this.values.length - 1)];
    if (value === undefined) throw new Error("clock sequence is empty");
    this.index += 1;
    return value;
  }
}

class SurfaceStorage {
  private alarm: number | null = null;

  constructor(
    private readonly testSql: ReturnType<
      typeof emptySqliteFixture
    >["storage"],
  ) {}

  get sql(): SqlStorage {
    return sqlStorage(this.testSql);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(value: number | Date): Promise<void> {
    this.alarm = value instanceof Date ? value.valueOf() : value;
  }

  transactionSync<Value>(operation: () => Value): Value {
    return this.testSql.transactionSync(operation);
  }

  binding(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }
}

class FailingD1Database extends SqliteD1Database {
  private failBatch = false;

  failNextBatch(): void {
    this.failBatch = true;
  }

  override async batch<T = unknown>(
    statements: SqliteD1Statement[],
  ): Promise<D1Result<T>[]> {
    if (this.failBatch) {
      this.failBatch = false;
      throw new Error("injected_d1_batch_failure");
    }
    return super.batch<T>(statements);
  }
}
