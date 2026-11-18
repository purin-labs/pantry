import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { listPlacementActorRegistryEntries } from "../../src/actors/actor-registry";
import { connectorActorStub } from "../../src/actors/actor-router";
import { CaseDO } from "../../src/actors/case";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
  shownSlackPost,
} from "./slack-journey-support";

/**
 * A Slack message that fails on every attempt must not end in silence. When
 * the Connector has used the attempts of a message, it tells the thread one
 * time and settles the message as rejected.
 *
 * The journey opens a thread with one answered message. The Case then refuses
 * every admission of a reply, as a competing trigger would, so each of the
 * five attempts ends in a retry. Slack fails the first post of the notice.
 * The next claim posts it. A repeated Slack event adds no post, and a later
 * reply in the same thread is answered.
 */
it(
  "tells a Slack thread one time when a message has used all its attempts",
  attemptsExhaustedJourney,
  120_000,
);

const ATTEMPTS = 5;
const REFUSED_EVENT = "Ev_EXHAUSTED_REPLY";
const ANSWERS = ["The order is open.", "The order ships on Friday."] as const;

type Recorded = {
  modelRequests: number;
  failNextPost: boolean;
  failedPosts: number;
  readonly delivered: Record<string, string>[];
};

/** The Connector's record of one message: its open work or its receipt. */
type MessageRecord =
  | {
      readonly kind: "work";
      readonly state: string;
      readonly attempt: number;
      readonly reason: string | null;
    }
  | {
      readonly kind: "receipt";
      readonly outcome: string;
      readonly reason: string | null;
    };

async function attemptsExhaustedJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded: Recorded = {
    modelRequests: 0,
    failNextPost: false,
    failedPosts: 0,
    delivered: [],
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, recorded),
    ),
  );
  const refusals = refuseAdmissionOf(test, REFUSED_EVENT);

  // The thread opens with one answered message.
  await sendSlack("Ev_EXHAUSTED_ROOT", ROOT_TS, "open the order");
  const connector = await connectorOf(fixture.connectorId);
  const record = readRecord.bind(null, connector);
  await expect
    .poll(() => record("Ev_EXHAUSTED_ROOT"), { timeout: 30_000 })
    .toEqual({ kind: "receipt", outcome: "completed", reason: null });
  expect(recorded.delivered.map(textOf)).toEqual([ANSWERS[0]]);

  // The Case refuses each attempt of the reply. Every attempt ends in a
  // retry, and the thread gets no post.
  const reply = {
    eventId: REFUSED_EVENT,
    messageTs: "1787500000.000002",
    text: "when does it ship",
  };
  await sendSlack(reply.eventId, reply.messageTs, reply.text);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) await claimAgain(connector, REFUSED_EVENT);
    await expect
      .poll(() => record(REFUSED_EVENT), { timeout: 30_000 })
      .toEqual({
        kind: "work",
        state: "retryable",
        attempt,
        reason: "case_trigger_conflict",
      });
  }
  expect(refusals.count).toBe(ATTEMPTS);
  expect(recorded.delivered).toHaveLength(1);

  // The next claim runs no turn. It posts the notice, and Slack fails that
  // post. The message stays open for another claim.
  recorded.failNextPost = true;
  await claimAgain(connector, REFUSED_EVENT);
  await expect
    .poll(() => record(REFUSED_EVENT), { timeout: 30_000 })
    .toEqual({
      kind: "work",
      state: "retryable",
      attempt: ATTEMPTS + 1,
      reason: "connector_delivery_pending",
    });
  expect(recorded.failedPosts).toBe(1);
  expect(recorded.delivered).toHaveLength(1);

  // The message is due again when Slack may be asked again. The claim at
  // that time posts the notice and settles the message as rejected. The
  // journey waits for that time: an earlier claim would use a notice claim
  // and post nothing.
  await expect
    .poll(
      async () => {
        await runDurableObjectAlarm(connector);
        return record(REFUSED_EVENT);
      },
      { timeout: 30_000, interval: 500 },
    )
    .toEqual({
      kind: "receipt",
      outcome: "rejected",
      reason: "connector_case_work_attempts_exhausted",
    });
  expect(recorded.delivered).toHaveLength(2);
  const notice = recorded.delivered[1];
  expect(notice?.thread_ts).toBe(ROOT_TS);
  expect(ANSWERS).not.toContain(notice?.text);
  // The notice claims asked the Case for nothing and called no model.
  expect(refusals.count).toBe(ATTEMPTS);
  expect(recorded.modelRequests).toBe(1);

  // Slack sends the same event again. The thread gets no second notice.
  await sendSlack(reply.eventId, reply.messageTs, reply.text);
  await runDurableObjectAlarm(connector);
  expect(await record(REFUSED_EVENT)).toEqual({
    kind: "receipt",
    outcome: "rejected",
    reason: "connector_case_work_attempts_exhausted",
  });
  expect(recorded.delivered).toHaveLength(2);

  // The thread still works: a new reply is answered.
  await sendSlack("Ev_EXHAUSTED_NEXT", "1787500000.000003", "confirm the day");
  await expect
    .poll(() => record("Ev_EXHAUSTED_NEXT"), { timeout: 30_000 })
    .toEqual({ kind: "receipt", outcome: "completed", reason: null });
  expect(recorded.delivered.map(textOf)).toEqual([
    ANSWERS[0],
    notice?.text,
    ANSWERS[1],
  ]);
  expect(recorded.modelRequests).toBe(2);

  Object.assign(test.task.meta, {
    slackAttemptsExhaustedNotice: {
      refusedAttempts: refusals.count,
      failedNoticePosts: recorded.failedPosts,
      posts: recorded.delivered.map(function summarise(post) {
        return { thread: post.thread_ts, text: post.text };
      }),
      refusedMessage: await record(REFUSED_EVENT),
      modelRequests: recorded.modelRequests,
    },
  });
}

/** Make the Case refuse every admission of one Slack message. */
function refuseAdmissionOf(
  test: TestContext,
  eventId: string,
): { count: number } {
  const refusals = { count: 0 };
  const admit = CaseDO.prototype.prepareOngoingTurn;
  CaseDO.prototype.prepareOngoingTurn = async function refuse(
    this: CaseDO,
    raw: unknown,
  ) {
    if (
      isRecord(raw) &&
      isRecord(raw.trigger) &&
      raw.trigger.triggerId === `trigger_ingress_slack_${eventId}`
    ) {
      refusals.count += 1;
      return { ok: false, error: { code: "case_trigger_conflict" } };
    }
    return admit.call(this, raw);
  };
  test.onTestFinished(function restoreAdmission(): void {
    CaseDO.prototype.prepareOngoingTurn = admit;
  });
  return refusals;
}

async function sendSlack(
  eventId: string,
  messageTs: string,
  text: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: messageTs === ROOT_TS ? "app_mention" : "message",
        eventId,
        messageTs,
        threadTs: ROOT_TS,
        text: messageTs === ROOT_TS ? `<@U0SATYR> ${text}` : text,
      }),
    ),
  );
  expect(response.status).toBe(200);
}

/** Make the message's retry due now, and run the alarm that claims it. */
async function claimAgain(
  connector: Awaited<ReturnType<typeof connectorOf>>,
  eventId: string,
): Promise<void> {
  await runInDurableObject(connector, makeRetryDue.bind(null, eventId));
  await runDurableObjectAlarm(connector);
}

function makeRetryDue(
  eventId: string,
  _actor: unknown,
  ctx: DurableObjectState,
): void {
  ctx.storage.sql.exec(
    "UPDATE connector_case_work SET due_at = 0 WHERE event_id = ? AND state_kind = 'retryable'",
    eventId,
  );
}

function readRecord(
  connector: Awaited<ReturnType<typeof connectorOf>>,
  eventId: string,
): Promise<MessageRecord | null> {
  return runInDurableObject(connector, readMessageRecord.bind(null, eventId));
}

function readMessageRecord(
  eventId: string,
  _actor: unknown,
  ctx: DurableObjectState,
): MessageRecord | null {
  const receipt = ctx.storage.sql
    .exec<{ outcome: string; reason: string | null }>(
      "SELECT outcome, reason FROM connector_case_work_receipt WHERE event_id = ?",
      eventId,
    )
    .toArray()[0];
  if (receipt !== undefined)
    return {
      kind: "receipt",
      outcome: receipt.outcome,
      reason: receipt.reason,
    };
  const work = ctx.storage.sql
    .exec<{ state_kind: string; attempt: number; retry_reason: string | null }>(
      "SELECT state_kind, attempt, retry_reason FROM connector_case_work WHERE event_id = ?",
      eventId,
    )
    .toArray()[0];
  return work === undefined
    ? null
    : {
        kind: "work",
        state: work.state_kind,
        attempt: work.attempt,
        reason: work.retry_reason,
      };
}

async function connectorOf(connectorId: string) {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 1,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  const entry = entries.value.find(function isConnector(candidate) {
    return (
      candidate.identity.objectKind === "connector" &&
      candidate.identity.logicalObjectId === connectorId
    );
  });
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return connectorActorStub(
    env.CONNECTOR,
    entry.physicalObjectName,
    entry.placement,
  );
}

function textOf(post: Record<string, string>): string | undefined {
  return post.text;
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  await request.json();
  const answer = ANSWERS[recorded.modelRequests];
  if (answer === undefined) throw new Error("Unexpected model request");
  recorded.modelRequests += 1;
  return openRouterText(
    answer,
    `chatcmpl_exhausted_${String(recorded.modelRequests)}`,
  );
}

async function respondToSlack(
  recorded: Recorded,
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const raw: unknown = slackPostFields(await request.json());
  if (!isStringRecord(raw)) throw new Error("Slack request body is invalid");
  const body = shownSlackPost(raw);
  if (params.method !== "chat.postMessage")
    return HttpResponse.json({ ok: true });
  if (recorded.failNextPost) {
    recorded.failNextPost = false;
    recorded.failedPosts += 1;
    return new HttpResponse(null, { status: 503 });
  }
  recorded.delivered.push(body);
  return HttpResponse.json({
    ok: true,
    channel: body.channel,
    ts: `1787500910.${String(recorded.delivered.length).padStart(6, "0")}`,
  });
}
