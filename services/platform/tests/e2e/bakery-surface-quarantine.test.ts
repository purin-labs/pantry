import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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
 */
it(
  "quarantines damaged Satyr Kitchen effects so that Session recovery stops reading them",
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
        text: "<@U0SATYR> check tomorrow's croissant order",
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
  await runInDurableObject(session, seedDamagedSurfaceEffects);
  expect(await runInDurableObject(session, readDamagedSurfaceEffects)).toEqual({
    candidates: DAMAGED_EFFECTS,
    quarantined: 0,
  });

  // A recovery pass ends one full page of damaged effects and comes back for
  // the rest; the next pass ends them and arms no retry for them.
  expect(await runDurableObjectAlarm(session)).toBe(true);
  expect(await runInDurableObject(session, readDamagedSurfaceEffects)).toEqual({
    candidates: 1,
    quarantined: 32,
  });
  expect(await runDurableObjectAlarm(session)).toBe(true);
  const settled = await runInDurableObject(session, readDamagedSurfaceEffects);
  expect(settled).toEqual({ candidates: 0, quarantined: DAMAGED_EFFECTS });
  const alarmAt = await runInDurableObject(session, readAlarm);
  expect(alarmAt === null || alarmAt > Date.now() + 5_000).toBe(true);

  // A later pass reads none of them again.
  await runDurableObjectAlarm(session);
  expect(await runInDurableObject(session, readDamagedSurfaceEffects)).toEqual(
    settled,
  );
  Object.assign(test.task.meta, {
    bakerySurfaceQuarantine: {
      damaged: DAMAGED_EFFECTS,
      afterRecovery: settled,
      alarmAt,
    },
  });
}

/** Writes settled and uncertain effects whose request recovery cannot read. */
function seedDamagedSurfaceEffects(
  _actor: unknown,
  state: DurableObjectState,
): void {
  const now = Date.now();
  for (let index = 0; index < DAMAGED_EFFECTS; index++) {
    const settled = index % 2 === 0;
    state.storage.sql.exec(
      `INSERT INTO actor_outbox
        (effect_id, organisation_id, originating_event_id, request_envelope, state_kind, state_projection, updated_at)
       VALUES (?, ?, 'surface-dispatched', ?, ?, ?, ?)`,
      `surface-damaged-${String(index).padStart(2, "0")}`,
      ORGANISATION_ID,
      JSON.stringify({ kind: "bakery_surface_effect.v1" }),
      settled ? "settled" : "indeterminate",
      JSON.stringify(
        settled
          ? { kind: "surface_settled", receipt: null, settledAt: now }
          : { kind: "surface_indeterminate", reason: "expired_after_dispatch" },
      ),
      now - 60_000 + index,
    );
  }
}

function readDamagedSurfaceEffects(
  _actor: unknown,
  state: DurableObjectState,
): { candidates: number; quarantined: number } {
  const count = (states: string) =>
    state.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM actor_outbox
         WHERE effect_id LIKE 'surface-damaged-%' AND state_kind IN (${states})`,
      )
      .one().count;
  return {
    candidates: count("'dispatching', 'settled', 'indeterminate'"),
    quarantined: count("'quarantined'"),
  };
}

function readAlarm(
  _actor: unknown,
  state: DurableObjectState,
): Promise<number | null> {
  return state.storage.getAlarm();
}
