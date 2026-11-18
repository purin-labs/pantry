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
import { parseOrganisationId, parseSessionId } from "../../src/ids";

/**
 * A running turn is a pending turn, not effect work (Refactor 15, refactor
 * 3).
 *
 * A person asks Pantry a question in Slack, and the model's answer is held.
 * While the turn runs, the cutover inspection of its Session counts one
 * pending turn and no pending effect: the turn's continuation lives in its
 * own table. After the answer reaches the thread, it counts neither.
 */
it(
  "counts a running turn as a pending turn and not as effect work",
  runningTurnCutoverJourney,
  60_000,
);

async function runningTurnCutoverJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const slack = slackSimulator();
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", async () => {
      await released;
      return openRouterText("Tomorrow's order holds 120 croissants.", "held");
    }),
    slack.handler,
  );
  const asked = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "EvR15CutoverContinuation",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0SATYR> check tomorrow's croissant order",
      }),
    ),
  );
  expect(asked.status).toBe(200);
  const session = await expect
    .poll(sessionUnderTurn, { timeout: 30_000, interval: 200 })
    .not.toBeNull()
    .then(sessionUnderTurn);
  if (session === null) throw new Error("Session missing");

  const running = await inspect(session);
  expect(running.work).toMatchObject({ pendingTurns: 1, pendingEffects: 0 });
  expect(running.blockers).toContain("pending_turns");
  expect(running.blockers).not.toContain("pending_effects");

  release();
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(1);
  await expect
    .poll(async () => (await inspect(session)).work.pendingTurns, {
      timeout: 10_000,
    })
    .toBe(0);
  Object.assign(test.task.meta, {
    sessionCutoverContinuation: { running: running.work },
  });
}

/** The Session whose turn runs now: it has a running turn stream. */
async function sessionUnderTurn(): Promise<{
  stub: DurableObjectStub;
  sessionId: string;
} | null> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name, logical_object_id AS sessionId FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active' LIMIT 1",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string; sessionId: string }>();
  if (row === null) return null;
  const stub = env.SESSION.getByName(row.name);
  const streams = await runInDurableObject(stub, readRunningStreams);
  return streams > 0 ? { stub, sessionId: row.sessionId } : null;
}

function readRunningStreams(
  _actor: unknown,
  state: DurableObjectState,
): number {
  const tables = state.storage.sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_turn_stream'",
    )
    .toArray();
  if (tables.length === 0) return 0;
  return state.storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM session_turn_stream WHERE state = 'running'",
    )
    .one().count;
}

async function inspect(session: {
  stub: DurableObjectStub;
  sessionId: string;
}): Promise<{
  work: Record<string, number>;
  blockers: readonly string[];
}> {
  const organisationId = parseOrganisationId(ORGANISATION_ID);
  const sessionId = parseSessionId(session.sessionId);
  if (!organisationId.ok || !sessionId.ok) throw new Error("Identity invalid");
  const stub = env.SESSION.get(session.stub.id);
  const inspected = await stub.inspectCutoverQuiescence({
    organisationId: organisationId.value,
    sessionId: sessionId.value,
  });
  if (!inspected.ok) throw new Error(inspected.error.code);
  return {
    work: { ...inspected.value.work },
    blockers: inspected.value.blockers,
  };
}
