import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { network } from "./network";
import { connectorOf, readFollowUps } from "./slack-follow-up-support";
import {
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

/**
 * A tool never runs on an argument that Pi had to change the meaning of.
 *
 * The model asks to come back in 2.5 minutes, and then with no note at all.
 * Pi would run the first call with 2 minutes and the second with the note
 * "null". Pantry refuses both, so nothing is scheduled and the model reads why.
 * The call with whole minutes as text keeps its value, and it is the only
 * follow-up that the thread gets.
 */
it(
  "refuses tool arguments that coercion would change, and runs the call that keeps its value",
  followUpArgumentsJourney,
  120_000,
);

const NOTE = "Check whether the croissant dough has doubled and tell Mia.";
const ANSWER = "I will check the dough in 40 minutes.";

type Recorded = { readonly requests: Record<string, unknown>[] };

async function followUpArgumentsJourney(test: TestContext): Promise<void> {
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
        eventId: "Ev_FOLLOW_UP_ARGUMENTS",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0SATYR> check the croissant dough in 40 minutes",
      }),
    ),
  );
  expect(response.status).toBe(200);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(1);
  expect(slack.messages[0]?.text).toBe(ANSWER);
  expect(recorded.requests).toHaveLength(4);

  const connector = await connectorOf(fixture.connectorId);
  const followUps = await runInDurableObject(connector, readFollowUps);
  expect(followUps).toHaveLength(1);
  const minutesUntilDue = Math.round(
    ((followUps[0]?.dueAt ?? 0) - Date.now()) / 60_000,
  );
  expect(minutesUntilDue).toBe(40);

  Object.assign(test.task.meta, {
    followUpArguments: {
      modelRequests: recorded.requests.length,
      minutesUntilDue,
      followUps: followUps.length,
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
      return openRouterToolCall(
        "schedule_follow_up",
        { afterMinutes: 2.5, note: NOTE },
        "call_fractional",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("afterMinutes");
      return openRouterToolCall(
        "schedule_follow_up",
        { afterMinutes: 40, note: null },
        "call_no_note",
      );
    case 3:
      expect(requireLastToolOutput(body)).toContain("note");
      return openRouterToolCall(
        "schedule_follow_up",
        { afterMinutes: "40", note: NOTE },
        "call_whole_text",
      );
    case 4:
      expect(requireLastToolOutput(body)).toContain("follow_up_scheduled");
      return openRouterText(ANSWER, "follow_up_scheduled");
    default:
      throw new Error("Unexpected model request");
  }
}
