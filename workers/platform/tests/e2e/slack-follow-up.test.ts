import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { SLACK_FOLLOW_UP_TEXT } from "@purin-labs/surface-slack/server/actors/connector-slack-case-work";
import { network } from "./network";
import {
  connectorOf,
  makeFollowUpsDue,
  readReceipt,
  readFollowUps,
} from "./slack-follow-up-support";
import {
  ROOT_TS,
  installSlackActorFixture,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
  threadAndText,
} from "./slack-journey-support";
import { runAlarmHandler } from "./durable-object-alarm-support";

/**
 * An agent in a Slack thread can come back later.
 *
 * A person asks Pantry to check the dough in 40 minutes. The model calls
 * `schedule_follow_up` with a note and answers. An alarm before that time
 * starts nothing. At the time, the Connector starts one new turn in the same
 * thread, for the same person: the model gets the follow-up message, reads
 * the note in its own earlier call, and its answer reaches the thread. A
 * second alarm starts no second turn, and a replay of the scheduling call
 * schedules nothing more.
 */
it(
  "comes back to a Slack thread once, at the time the agent scheduled",
  followUpJourney,
  120_000,
);

const NOTE = "Check whether the croissant dough has doubled and tell Mia.";
const ANSWERS = {
  scheduled: "I will check the dough in 40 minutes.",
  followedUp: "Time to check the croissant dough: it should have doubled.",
} as const;

type Recorded = {
  readonly requests: Record<string, unknown>[];
};

async function followUpJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded: Recorded = { requests: [] };
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    slack.handler,
  );

  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev_FOLLOW_UP_ROOT",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> check the croissant dough in 40 minutes",
      }),
    ),
  );
  expect(response.status).toBe(200);
  const connector = await connectorOf(fixture.connectorId);
  const rootReceipt = readReceipt.bind(null, "Ev_FOLLOW_UP_ROOT");
  await expect
    .poll(() => runInDurableObject(connector, rootReceipt), {
      timeout: 30_000,
    })
    .toBe("completed");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(recorded.requests).toHaveLength(2);
  const scheduledAt = Date.now();

  // The follow-up waits for its time: an alarm now starts no turn.
  const waiting = await runInDurableObject(connector, readFollowUps);
  expect(waiting).toHaveLength(1);
  const dueAt = waiting[0]?.dueAt ?? 0;
  expect(dueAt).toBeGreaterThan(scheduledAt + 39 * 60_000);
  expect(dueAt).toBeLessThan(scheduledAt + 41 * 60_000);
  await runAlarmHandler(connector);
  expect(recorded.requests).toHaveLength(2);
  expect(slack.messages).toHaveLength(1);

  // At its time, one turn runs in the same thread and answers there.
  await runInDurableObject(connector, makeFollowUpsDue);
  await runAlarmHandler(connector);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  await expect
    .poll(() => runInDurableObject(connector, readFollowUps), {
      timeout: 30_000,
    })
    .toEqual([
      { eventId: waiting[0]?.eventId, dueAt: null, outcome: "completed" },
    ]);
  expect(recorded.requests).toHaveLength(3);
  const followUpRequest = JSON.stringify(recorded.requests[2]);
  expect(followUpRequest).toContain(SLACK_FOLLOW_UP_TEXT);
  // The note reaches the model only from the thread's own history.
  expect(followUpRequest).toContain(NOTE);
  expect(slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWERS.scheduled },
    { thread: ROOT_TS, text: ANSWERS.followedUp },
  ]);

  // The alarm runs at least once: a second run starts no second turn.
  await runAlarmHandler(connector);
  expect(recorded.requests).toHaveLength(3);
  expect(slack.messages).toHaveLength(2);

  Object.assign(test.task.meta, {
    slackFollowUp: {
      minutesUntilDue: Math.round((dueAt - scheduledAt) / 60_000),
      modelRequests: recorded.requests.length,
      posts: slack.messages.map(threadAndText),
      followUp: await runInDurableObject(connector, readFollowUps),
    },
  });
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  switch (recorded.requests.length) {
    case 1:
      expect(offeredToolNames(body)).toContain("schedule_follow_up");
      return openRouterToolCall(
        "schedule_follow_up",
        { afterMinutes: 40, note: NOTE },
        "call_follow_up",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("follow_up_scheduled");
      return openRouterText(ANSWERS.scheduled, "follow_up_scheduled");
    case 3:
      return openRouterText(ANSWERS.followedUp, "follow_up_answered");
    default:
      throw new Error("Unexpected model request");
  }
}
