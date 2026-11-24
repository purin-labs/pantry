import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";

import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";
import {
  readAlarm,
  readDamagedSurfaceEffects,
  seedDamagedSurfaceEffects,
} from "./case-execution-support";
import { createBakerySurfaceEffect } from "@purin-labs/bakery-model/bakery-surface";
import { listBakerySurfaceTimelineEvents } from "@purin-labs/area-kitchen/server/actors/bakery-surface-effect";
import { requireOrganisationId } from "../test-ids";
import { runAlarmHandler, runArmedAlarm } from "./durable-object-alarm-support";

/**
 * Refactor 15: damaged Kitchen effects do not hold the Session's
 * recovery.
 *
 * A person asks Pantry a question in Slack, and the Session answers. Its
 * storage then holds 33 Kitchen effects that recovery cannot read: a
 * settled or uncertain effect whose request is damaged. Before the fix such a
 * row stayed a recovery candidate for good, and a full page of them armed
 * the Session's alarm every second. Now recovery ends each of them as
 * quarantined, one page for each pass, and then reads none of them again.
 *
 * One of them was published to the page: its delivery waits as dispatching,
 * with a started event on the chat's timeline. Its quarantine ends that
 * delivery as uncertain, so the timeline shows its end and the page is not
 * offered it again.
 */
it(
  "quarantines damaged Kitchen effects so that Session recovery stops reading them",
  damagedSurfaceEffectJourney,
  60_000,
);

const DAMAGED_EFFECTS = 33;

async function damagedSurfaceEffectJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const slack = slackSimulator();
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () =>
      openRouterText("Tomorrow's order holds 120 croissants.", "answer"),
    ),
    slack.handler,
  );
  const asked = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "EvR15SurfaceQuarantine",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> check tomorrow's croissant order",
      }),
    ),
  );
  expect(asked.status).toBe(200);
  await expect
    .poll(() => slack.visibleMessageCount(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const registry = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (registry === null) throw new Error("Session Actor missing");
  const session = env.SESSION.getByName(registry.name);

  // The fault: damaged effect rows, more than one recovery page.
  await runInDurableObject(
    session,
    seedDamagedSurfaceEffects(ORGANISATION_ID, DAMAGED_EFFECTS),
  );
  const published = await publishedDelivery("surface-damaged-01");
  expect(await runInDurableObject(session, readDamagedSurfaceEffects)).toEqual({
    candidates: DAMAGED_EFFECTS,
    quarantined: 0,
  });

  // A recovery pass ends one full page of damaged effects and comes back for
  // the rest; the next pass ends them and arms no retry for them.
  await runArmedAlarm(session);
  expect(await runInDurableObject(session, readDamagedSurfaceEffects)).toEqual({
    candidates: 1,
    quarantined: 32,
  });
  await runArmedAlarm(session);
  const settled = await runInDurableObject(session, readDamagedSurfaceEffects);
  expect(settled).toEqual({ candidates: 0, quarantined: DAMAGED_EFFECTS });
  const alarmAt = await runInDurableObject(session, readAlarm);
  expect(alarmAt === null || alarmAt > Date.now() + 5_000).toBe(true);

  // A later pass reads none of them again.
  await runAlarmHandler(session);
  expect(await runInDurableObject(session, readDamagedSurfaceEffects)).toEqual(
    settled,
  );

  // The published effect ends as uncertain on the chat's timeline, and its
  // delivery no longer waits for the page.
  const timeline = await listBakerySurfaceTimelineEvents({
    db: fixtureDatabase(),
    organisationId: requireOrganisationId(ORGANISATION_ID),
    userId: published.userId,
    requestIds: [published.requestId],
    afterSequence: 0,
  });
  expect(timeline.map((event) => event.terminal.kind)).toEqual([
    "started",
    "indeterminate",
  ]);
  expect(
    await fixtureDatabase()
      .prepare(
        "SELECT state_kind AS state FROM bakery_surface_effect_delivery WHERE effect_id = ?",
      )
      .bind(published.effectId)
      .first<{ state: string }>(),
  ).toEqual({ state: "indeterminate" });
  Object.assign(test.task.meta, {
    bakerySurfaceQuarantine: {
      damaged: DAMAGED_EFFECTS,
      afterRecovery: settled,
      alarmAt,
    },
  });
}

/**
 * The page delivery of one damaged effect, as the Session published it: a
 * valid effect that waits as dispatching, with its started timeline event.
 */
async function publishedDelivery(effectId: string): Promise<{
  effectId: string;
  userId: string;
  requestId: string;
}> {
  const now = Date.now();
  const effect = await createBakerySurfaceEffect({
    effectId,
    dispatchId: "damaged_dispatch",
    deadlineAt: now + 10 * 60_000,
    command: {
      schemaVersion: 1,
      kind: "prepare_run_save",
      target: { surfaceSessionId: crypto.randomUUID(), surfaceEpoch: 0 },
      name: "Damaged save",
    },
  });
  const ids = {
    userId: "user_damaged_surface",
    sessionId: "session_damaged_surface",
    turnId: "turn_damaged_surface",
    requestId: "request_damaged_surface",
  };
  const db = fixtureDatabase();
  await db.batch([
    db
      .prepare(
        `INSERT INTO bakery_surface_effect_delivery (
          effect_id, organisation_id, user_id, session_id, turn_id,
          request_id, surface_session_id, surface_epoch, command_digest,
          effect_json, state_kind, receipt_json, deadline_at, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'dispatching', NULL, ?, ?, ?)`,
      )
      .bind(
        effectId,
        ORGANISATION_ID,
        ids.userId,
        ids.sessionId,
        ids.turnId,
        ids.requestId,
        effect.command.kind === "prepare_run_save"
          ? effect.command.target.surfaceSessionId
          : "",
        effect.commandDigest,
        JSON.stringify(effect),
        effect.deadlineAt,
        now - 60_000,
        now - 60_000,
      ),
    db
      .prepare(
        `INSERT INTO bakery_surface_timeline_event (
          organisation_id, user_id, session_id, turn_id, request_id,
          effect_id, event_kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?)`,
      )
      .bind(
        ORGANISATION_ID,
        ids.userId,
        ids.sessionId,
        ids.turnId,
        ids.requestId,
        effectId,
        now - 60_000,
      ),
  ]);
  return { effectId, userId: ids.userId, requestId: ids.requestId };
}
