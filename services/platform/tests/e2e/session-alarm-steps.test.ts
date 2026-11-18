import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";

import { SessionDO } from "../../src/actors/agent-session";
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
 * One failing alarm step does not stop the Session's other work (Refactor
 * 15, S3).
 *
 * A person asks Pantry a question in Slack, and the Session answers. Its
 * storage then holds Kitchen effects that recovery cannot read, and
 * the alarm's first step, the completion of accepted checkpoints, fails on
 * every pass. The alarm still ends the damaged effects as quarantined, and
 * it comes back for the failed step after its backoff, not at once.
 */
it(
  "runs the Session's later alarm work when an earlier alarm step fails",
  failingAlarmStepJourney,
  60_000,
);

const DAMAGED_EFFECTS = 3;

async function failingAlarmStepJourney(test: TestContext): Promise<void> {
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
        eventId: "EvR15AlarmSteps",
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

  // The faults: damaged effect rows, and a first alarm step that fails.
  await runInDurableObject(session, seedDamagedSurfaceEffects);
  test.onTestFinished(failCheckpointCompletion());

  const ranAt = Date.now();
  await runDurableObjectAlarm(session).catch(ignoreAlarmFailure);
  expect(await runInDurableObject(session, readDamagedSurfaceEffects)).toEqual({
    candidates: 0,
    quarantined: DAMAGED_EFFECTS,
  });
  const alarmAt = await runInDurableObject(session, readAlarm);
  expect(alarmAt).not.toBeNull();
  expect(alarmAt ?? 0).toBeGreaterThanOrEqual(ranAt + 10_000);
  Object.assign(test.task.meta, {
    sessionAlarmSteps: {
      damaged: DAMAGED_EFFECTS,
      retryInMs: (alarmAt ?? 0) - ranAt,
    },
  });
}

/** The old alarm stops with the step's error; the journey reads what ran. */
function ignoreAlarmFailure(): boolean {
  return false;
}

/** The completion of accepted checkpoints fails on every alarm pass. */
function failCheckpointCompletion(): () => void {
  const prototype = SessionDO.prototype as unknown as Record<string, unknown>;
  const original = prototype.resumeAcceptedCheckpointFinalization;
  Object.defineProperty(prototype, "resumeAcceptedCheckpointFinalization", {
    value: function failingCompletion(): Promise<void> {
      return Promise.reject(new Error("checkpoint completion unavailable"));
    },
    configurable: true,
    writable: true,
  });
  return () =>
    Object.defineProperty(prototype, "resumeAcceptedCheckpointFinalization", {
      value: original,
      configurable: true,
      writable: true,
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
