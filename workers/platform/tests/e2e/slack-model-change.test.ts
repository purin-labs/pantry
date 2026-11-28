import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";
import { PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS } from "@purin-labs/agent/actors/pi-embedded-adapter";
import { network } from "./network";
import { connectorOf, readReceipt } from "./slack-follow-up-support";
import {
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  postMention,
  slackSimulator,
  threadAndText,
} from "./slack-journey-support";

/**
 * Slack threads keep working when a release changes the default model of
 * Pantry's paid route (spec FND-04).
 *
 * Before the release, a person asks in a thread and Kimi K3 answers. The
 * release changes the default to Gemini 4 Hydrogen. The person's next message
 * in the open thread gets one answer in that thread: the thread's Session
 * keeps the model that it started with, and that model reads the earlier
 * answer. A new thread after the release gets its answer from Gemini 4
 * Hydrogen. So an earlier default must stay runnable while an open thread
 * can pin it.
 */
it(
  "keeps an open Slack thread on its model and starts a new thread on the new default",
  slackModelChangeJourney,
  120_000,
);

/**
 * A later release removes a model from the list while an open thread pins
 * it. The thread's next message gets its answer from the current default:
 * the Session continues in a new lineage that carries the thread's history,
 * and the thread stays on the default after that.
 */
it(
  "continues a thread whose pinned model left the list on the current default, with its history",
  removedModelJourney,
  120_000,
);

const EARLIER_DEFAULT = "moonshotai/kimi-k3";
const REMOVED_MODEL = "qwen/qwen3.7-flash";
const REPLY_TS = "1787500000.000002";
const NEW_ROOT_TS = "1787500100.000001";
const ANSWERS = [
  "Twelve croissants are left.",
  "Yes, bake one more tray of twelve.",
  "The oven is at 190 degrees.",
] as const;

type Recorded = { readonly requests: Record<string, unknown>[] };

async function slackModelChangeJourney(test: TestContext): Promise<void> {
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

  // Before the release: the paid route runs the earlier default.
  env.PANTRY_PLATFORM_PI_MODEL = EARLIER_DEFAULT;
  test.onTestFinished(() => {
    delete env.PANTRY_PLATFORM_PI_MODEL;
  });
  await mention(
    "Ev_MODEL_CHANGE_ROOT",
    ROOT_TS,
    ROOT_TS,
    "how many croissants are left?",
  );
  // The first event starts the Connector of the workspace.
  const connector = await connectorOf(fixture.connectorId);
  const settled = (eventId: string) =>
    expect
      .poll(
        () => runInDurableObject(connector, readReceipt.bind(null, eventId)),
        {
          timeout: 30_000,
        },
      )
      .toBe("completed");
  await settled("Ev_MODEL_CHANGE_ROOT");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  // The release: the variable is gone, and the code default applies.
  delete env.PANTRY_PLATFORM_PI_MODEL;
  await mention(
    "Ev_MODEL_CHANGE_REPLY",
    REPLY_TS,
    ROOT_TS,
    "should we bake more?",
  );
  await settled("Ev_MODEL_CHANGE_REPLY");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  // The open thread continues on its own model and reads its history.
  expect(JSON.stringify(recorded.requests[1])).toContain(ANSWERS[0]);

  await mention(
    "Ev_MODEL_CHANGE_NEW",
    NEW_ROOT_TS,
    NEW_ROOT_TS,
    "how hot is the oven?",
  );
  await settled("Ev_MODEL_CHANGE_NEW");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);

  expect(slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWERS[0] },
    { thread: ROOT_TS, text: ANSWERS[1] },
    { thread: NEW_ROOT_TS, text: ANSWERS[2] },
  ]);
  expect(recorded.requests.map(requestedModel)).toEqual([
    EARLIER_DEFAULT,
    EARLIER_DEFAULT,
    PLATFORM_DEFAULT_PI_MODEL,
  ]);

  Object.assign(test.task.meta, {
    slackModelChange: {
      before: EARLIER_DEFAULT,
      after: PLATFORM_DEFAULT_PI_MODEL,
      requests: recorded.requests.map(requestedModel),
      slackMessages: slack.messages.map(threadAndText),
    },
  });
}

async function removedModelJourney(test: TestContext): Promise<void> {
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
  env.PANTRY_PLATFORM_PI_MODEL = REMOVED_MODEL;
  const adapters: Record<string, unknown> = PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS;
  const removedAdapter = adapters[REMOVED_MODEL];
  test.onTestFinished(() => {
    delete env.PANTRY_PLATFORM_PI_MODEL;
    adapters[REMOVED_MODEL] = removedAdapter;
  });
  await mention(
    "Ev_MODEL_REMOVED_ROOT",
    ROOT_TS,
    ROOT_TS,
    "how many croissants are left?",
  );
  const connector = await connectorOf(fixture.connectorId);
  const settled = (eventId: string) =>
    expect
      .poll(
        () => runInDurableObject(connector, readReceipt.bind(null, eventId)),
        { timeout: 30_000 },
      )
      .toBe("completed");
  await settled("Ev_MODEL_REMOVED_ROOT");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  // The release: the pinned model has no adapter any more, and the route
  // runs the code default.
  delete adapters[REMOVED_MODEL];
  delete env.PANTRY_PLATFORM_PI_MODEL;
  await mention("Ev_MODEL_REMOVED_REPLY", REPLY_TS, ROOT_TS, "should we bake more?");
  await settled("Ev_MODEL_REMOVED_REPLY");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  // The new lineage reads the thread's earlier answer.
  expect(JSON.stringify(recorded.requests[1])).toContain(ANSWERS[0]);

  await mention(
    "Ev_MODEL_REMOVED_THIRD",
    "1787500000.000003",
    ROOT_TS,
    "how hot is the oven?",
  );
  await settled("Ev_MODEL_REMOVED_THIRD");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);
  expect(JSON.stringify(recorded.requests[2])).toContain(ANSWERS[1]);

  expect(slack.messages.map(threadAndText)).toEqual([
    { thread: ROOT_TS, text: ANSWERS[0] },
    { thread: ROOT_TS, text: ANSWERS[1] },
    { thread: ROOT_TS, text: ANSWERS[2] },
  ]);
  expect(recorded.requests.map(requestedModel)).toEqual([
    REMOVED_MODEL,
    PLATFORM_DEFAULT_PI_MODEL,
    PLATFORM_DEFAULT_PI_MODEL,
  ]);
  Object.assign(test.task.meta, {
    slackRemovedModel: {
      pinned: REMOVED_MODEL,
      continuedOn: PLATFORM_DEFAULT_PI_MODEL,
      requests: recorded.requests.map(requestedModel),
      slackMessages: slack.messages.map(threadAndText),
    },
  });
}

function mention(
  eventId: string,
  messageTs: string,
  threadTs: string,
  text: string,
): Promise<void> {
  return postMention(eventId, messageTs, text, threadTs);
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("model request is not an object");
  recorded.requests.push(body);
  const index = recorded.requests.length;
  return openRouterText(
    ANSWERS[index - 1] ?? "No more answers.",
    `slack_model_change_${String(index)}`,
  );
}

function requestedModel(body: Record<string, unknown>): unknown {
  return body.model;
}
