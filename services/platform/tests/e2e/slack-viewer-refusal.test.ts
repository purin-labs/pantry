import { exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  USER_ID,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";

const REFUSAL =
  "Your role in this organisation can view work but not ask the agent to do it. An owner or admin can change your role.";

it(
  "answers a linked viewer's mention with one private refusal, no Slack retry and no turn",
  viewerRefusalJourney,
  60_000,
);

async function viewerRefusalJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const model = countingModel();
  const slack = recordingSlack();
  network.use(model.handler, slack.handler);

  // No Connector serves the placement yet, so the Worker decides this mention.
  await setRole("viewer");
  const firstMention = await sendSlack({
    eventType: "app_mention",
    eventId: "EvViewer_WORKER",
    messageTs: "1787500200.000001",
    threadTs: "1787500200.000001",
    text: "<@U0SATYR> what sold today?",
  });
  expect(firstMention).toEqual({ status: 200, durableMode: "rejected" });
  await expect.poll(slack.refusalCount, { timeout: 15_000 }).toBe(1);
  expect(slack.refusals[0]).toEqual({
    channel: CHANNEL_ID,
    user: USER_ID,
    text: REFUSAL,
  });

  // The same person, as an operator, opens a Case and activates the Connector.
  await setRole("operator");
  const opened = await sendSlack({
    eventType: "app_mention",
    eventId: "EvViewer_OPEN",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: "<@U0SATYR> open this case",
  });
  expect(opened).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.messageCount, { timeout: 15_000 }).toBe(1);

  // The role falls to viewer. Now the Connector decides, in the Case's thread.
  await setRole("viewer");
  const threadMention = await sendSlack({
    eventType: "app_mention",
    eventId: "EvViewer_CONNECTOR",
    messageTs: "1787500000.000002",
    threadTs: ROOT_TS,
    text: "<@U0SATYR> one more thing",
  });
  expect(threadMention).toEqual({ status: 200, durableMode: "rejected" });
  await expect.poll(slack.refusalCount, { timeout: 15_000 }).toBe(2);
  expect(slack.refusals[1]).toEqual({
    channel: CHANNEL_ID,
    user: USER_ID,
    text: REFUSAL,
    thread_ts: ROOT_TS,
  });

  // A plain reply may be talk between people, so the viewer gets no message.
  const plainReply = await sendSlack({
    eventType: "message",
    eventId: "EvViewer_REPLY",
    messageTs: "1787500000.000003",
    threadTs: ROOT_TS,
    text: "thanks, that helps",
  });
  expect(plainReply).toEqual({ status: 200, durableMode: "rejected" });

  // The role comes back and the Case still answers. This reply also proves
  // that the viewer's messages added no turn before it.
  await setRole("operator");
  const resumed = await sendSlack({
    eventType: "message",
    eventId: "EvViewer_RESUMED",
    messageTs: "1787500000.000004",
    threadTs: ROOT_TS,
    text: "continue in the same case",
  });
  expect(resumed).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.messageCount, { timeout: 15_000 }).toBe(2);
  expect(model.requests()).toBe(2);
  expect(slack.refusals).toHaveLength(2);
  expect(slack.statuses).toHaveLength(2);
  Object.assign(test.task.meta, {
    slackViewerRefusal: {
      replies: { firstMention, threadMention, plainReply, opened, resumed },
      refusals: slack.refusals,
      modelRequests: model.requests(),
      deliveredMessages: slack.messages.length,
      progressStatuses: slack.statuses.length,
    },
  });
}

async function setRole(role: "operator" | "viewer"): Promise<void> {
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant SET role = ?
     WHERE organisation_id = ? AND person_id = 'person_e2e-slack-actor'`,
    )
    .bind(role, ORGANISATION_ID)
    .run();
}

async function sendSlack(
  input: Parameters<typeof slackEnvelope>[0],
): Promise<{ readonly status: number; readonly durableMode: string | null }> {
  const response = await exports.default.fetch(
    await signedSlackRequest(slackEnvelope(input)),
  );
  const body: unknown = await response.json();
  return {
    status: response.status,
    durableMode:
      isRecord(body) && typeof body.durableMode === "string"
        ? body.durableMode
        : null,
  };
}

function countingModel(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly requests: () => number;
} {
  let requests = 0;
  return {
    requests: () => requests,
    handler: http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        await request.json();
        requests += 1;
        return openRouterText(
          `Reply ${String(requests)}.`,
          `chatcmpl_viewer_${String(requests)}`,
        );
      },
    ),
  };
}

function recordingSlack(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly messages: Record<string, string>[];
  readonly statuses: Record<string, string>[];
  readonly refusals: Record<string, string>[];
  readonly messageCount: () => number;
  readonly refusalCount: () => number;
} {
  const messages: Record<string, string>[] = [];
  const statuses: Record<string, string>[] = [];
  const refusals: Record<string, string>[] = [];
  return {
    messages,
    statuses,
    refusals,
    messageCount: () => messages.length,
    refusalCount: () => refusals.length,
    handler: http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, { messages, statuses, refusals }),
    ),
  };
}

async function respondToSlack(
  recorded: {
    readonly messages: Record<string, string>[];
    readonly statuses: Record<string, string>[];
    readonly refusals: Record<string, string>[];
  },
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const body: unknown = slackPostFields(await request.json());
  if (!isStringRecord(body)) throw new Error("Slack request body is invalid");
  switch (params.method) {
    case "assistant.threads.setStatus":
      recorded.statuses.push(body);
      return HttpResponse.json({ ok: true });
    case "chat.postEphemeral":
      recorded.refusals.push(body);
      return HttpResponse.json({ ok: true });
    case "chat.postMessage":
      recorded.messages.push(body);
      return HttpResponse.json({
        ok: true,
        channel: body.channel,
        ts: `1787500001.${String(recorded.messages.length).padStart(6, "0")}`,
      });
    default:
      throw new Error(`Unexpected Slack method: ${String(params.method)}`);
  }
}
