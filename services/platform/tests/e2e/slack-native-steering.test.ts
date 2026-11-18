import { runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { network } from "./network";
import {
  connectorOf,
  readReceipt,
  readSteeredReplies,
} from "./slack-follow-up-support";
import {
  ROOT_TS,
  installSlackActorFixture,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
  sendSlack,
  threadAndText,
  userMessageContaining,
} from "./slack-journey-support";

/**
 * A reply in a Slack thread steers the running turn instead of waiting for
 * the next one (Plan 71).
 *
 * A person asks for a supplier check. While the turn's first model request
 * runs, the same person replies in the thread. The Connector offers the
 * reply to the running turn, which admits it, and the reply leaves the queue.
 * The model's next request holds the reply after the tool result, and the
 * thread gets one answer that follows it. The reply settles as completed
 * once the turn ends, no second turn runs, and the thread shows no thinking
 * status for a reply that gets no answer of its own.
 */
it(
  "steers the running Slack turn with a reply from the same person",
  slackSteeringJourney,
  120_000,
);

const ROOT_EVENT = "Ev_STEER_ROOT";
const REPLY_EVENT = "Ev_STEER_REPLY";
const REPLY_TEXT = "Only the flour supplier, please.";
const ANSWER = "The flour supplier delivers on Friday.";

type Model = {
  readonly requests: Record<string, unknown>[];
  readonly firstStarted: PromiseWithResolvers<void>;
  readonly releaseFirst: PromiseWithResolvers<void>;
};

async function slackSteeringJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const model: Model = {
    requests: [],
    firstStarted: Promise.withResolvers<void>(),
    releaseFirst: Promise.withResolvers<void>(),
  };
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, model),
    ),
    slack.handler,
  );

  await sendSlack(
    ROOT_EVENT,
    ROOT_TS,
    "<@U0SATYR> check our next supplier deliveries",
  );
  await model.firstStarted.promise;
  const connector = await connectorOf(fixture.connectorId);

  // The reply joins the running turn and leaves the queue.
  await sendSlack(REPLY_EVENT, "1787500000.000002", REPLY_TEXT);
  await expect
    .poll(() => runInDurableObject(connector, readSteeredReplies), {
      timeout: 15_000,
    })
    .toEqual([REPLY_EVENT]);
  model.releaseFirst.resolve();

  await expect
    .poll(
      () => runInDurableObject(connector, readReceipt.bind(null, REPLY_EVENT)),
      { timeout: 30_000 },
    )
    .toBe("completed");
  expect(
    await runInDurableObject(connector, readReceipt.bind(null, ROOT_EVENT)),
  ).toBe("completed");
  await expect
    .poll(lastThreadStatus.bind(null, slack.statuses), { timeout: 15_000 })
    .toBe("");

  // One turn: the reply after the tool result in the second request, and
  // one answer in the thread.
  expect(model.requests).toHaveLength(2);
  const second = messageList(model.requests[1]);
  const toolResult = second.findIndex(isToolMessage);
  const steering = second.findIndex(
    userMessageContaining.bind(null, REPLY_TEXT),
  );
  expect(toolResult).toBeGreaterThan(-1);
  expect(steering).toBeGreaterThan(toolResult);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWER },
  ]);
  expect(await runInDurableObject(connector, readSteeredReplies)).toEqual([]);

  // Slack sends the reply again: it is a duplicate, and nothing runs.
  await sendSlack(REPLY_EVENT, "1787500000.000002", REPLY_TEXT);
  expect(model.requests).toHaveLength(2);

  Object.assign(test.task.meta, {
    slackNativeSteering: {
      modelRequests: model.requests.length,
      secondRequestOrder: { toolResult, steering },
      posts: slack.messages.map(threadAndText),
      statuses: slack.statuses,
    },
  });
}

async function replyToModel(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  model.requests.push(body);
  switch (model.requests.length) {
    case 1:
      // The turn is busy while this request waits.
      model.firstStarted.resolve();
      await model.releaseFirst.promise;
      expect(offeredToolNames(body)).toContain("tool_search");
      return openRouterToolCall(
        "tool_search",
        { query: "supplier deliveries", limit: 1 },
        "call_supplier_search",
      );
    case 2:
      return openRouterText(ANSWER, "steered_answer");
    default:
      throw new Error("Unexpected model request");
  }
}

function lastThreadStatus(
  statuses: readonly Record<string, string>[],
): string | undefined {
  return statuses.filter(isRootThreadStatus).at(-1)?.status;
}

function isRootThreadStatus(status: Record<string, string>): boolean {
  return status.thread_ts === ROOT_TS;
}

function messageList(body: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function isToolMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "tool";
}
