import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { SLACK_FOLLOW_UP_TEXT } from "../../src/actors/connector-slack-case-work";
import { enableCapability } from "./access-route-support";
import { network } from "./network";
import {
  connectorOf,
  makeFollowUpsDue,
  readFollowUps,
} from "./slack-follow-up-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  slackSimulator,
  postMention,
} from "./slack-journey-support";

/**
 * A follow-up outlives an Access change, and not its requester.
 *
 * An operator asks Pantry to check the dough in 40 minutes, and the agent
 * schedules a follow-up. Before it is due, the owner changes Access, which
 * advances the Organisation's configuration version. At its time the
 * follow-up still runs once, for the same person, and answers in the thread.
 * In a second thread the operator asks for another follow-up and then leaves
 * the Organisation: at its time no turn runs and the thread gets nothing.
 */
it(
  "runs a follow-up after an Access change and drops it when its requester leaves",
  followUpAuthorityJourney,
  150_000,
);

const SECOND_ROOT_TS = "1787500200.000001";
const NOTES = {
  dough: "Check whether the croissant dough has doubled and tell Mia.",
  oven: "Check whether the oven reached 190 C.",
} as const;
const ANSWERS = {
  scheduledDough: "I will check the dough in 40 minutes.",
  followedUp: "Time to check the croissant dough: it should have doubled.",
  scheduledOven: "I will check the oven in 20 minutes.",
} as const;
const OPERATOR = "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab";

type Recorded = { readonly requests: Record<string, unknown>[] };

async function followUpAuthorityJourney(test: TestContext): Promise<void> {
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

  // 1. The agent schedules a follow-up, then the owner changes Access.
  await postMention(
    "Ev_AUTHORITY_DOUGH",
    ROOT_TS,
    "check the dough in 40 minutes",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(1);
  const connector = await connectorOf(fixture.connectorId);
  const versionBefore = await configurationVersion();
  await enableCapability(
    ORGANISATION_ID,
    fixture.ownerSession,
    "commerce.menu_draft.read",
  );
  expect(await configurationVersion()).toBeGreaterThan(versionBefore);

  // 2. At its time the follow-up runs once, for the same person.
  await runInDurableObject(connector, makeFollowUpsDue);
  await runDurableObjectAlarm(connector);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(recorded.requests).toHaveLength(3);
  expect(slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWERS.scheduledDough },
    { thread: ROOT_TS, text: ANSWERS.followedUp },
  ]);
  // The Connector settles the work after the reply is visible in Slack.
  await expect
    .poll(() => runInDurableObject(connector, readFollowUps), {
      timeout: 30_000,
    })
    .toEqual([
      { eventId: expect.any(String), dueAt: null, outcome: "completed" },
    ]);

  // 3. A follow-up whose requester left runs no turn and posts nothing.
  await postMention(
    "Ev_AUTHORITY_OVEN",
    SECOND_ROOT_TS,
    "check the oven in 20 minutes",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(3);
  expect(recorded.requests).toHaveLength(5);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID, OPERATOR)
    .run();
  await runInDurableObject(connector, makeFollowUpsDue);
  await runDurableObjectAlarm(connector);
  await expect
    .poll(() => runInDurableObject(connector, readFollowUps), {
      timeout: 30_000,
    })
    .toEqual(
      expect.arrayContaining([
        { eventId: expect.any(String), dueAt: null, outcome: "rejected" },
      ]),
    );
  expect(recorded.requests).toHaveLength(5);
  expect(slack.visibleMessageCount()).toBe(3);

  Object.assign(test.task.meta, {
    slackFollowUpAuthority: {
      configurationVersionBefore: versionBefore,
      configurationVersionAfter: await configurationVersion(),
      modelRequests: recorded.requests.length,
      noteReachedFollowUp: JSON.stringify(recorded.requests[2]).includes(
        NOTES.dough,
      ),
      posts: slack.messages.map(threadAndText),
      followUps: await runInDurableObject(connector, readFollowUps),
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
        { afterMinutes: 40, note: NOTES.dough },
        "call_follow_up_dough",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("follow_up_scheduled");
      return openRouterText(
        ANSWERS.scheduledDough,
        "follow_up_dough_scheduled",
      );
    case 3: {
      // The Access change gives the person a new Session, so the note of the
      // earlier call is not in its history. The person's request is.
      const input = JSON.stringify(body);
      expect(input).toContain(SLACK_FOLLOW_UP_TEXT);
      expect(input).toContain("check the dough in 40 minutes");
      return openRouterText(ANSWERS.followedUp, "follow_up_dough_answered");
    }
    case 4:
      return openRouterToolCall(
        "schedule_follow_up",
        { afterMinutes: 20, note: NOTES.oven },
        "call_follow_up_oven",
      );
    case 5:
      expect(requireLastToolOutput(body)).toContain("follow_up_scheduled");
      return openRouterText(ANSWERS.scheduledOven, "follow_up_oven_scheduled");
    default:
      throw new Error("Unexpected model request");
  }
}

/** The version that a Slack requester's authority is pinned to. */
async function configurationVersion(): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT MAX(configuration_version) AS version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ readonly version: number }>();
  if (row === null) throw new Error("E2E onboarding missing");
  return row.version;
}

function threadAndText(post: Record<string, string>) {
  return { thread: post.thread_ts, text: post.text };
}
