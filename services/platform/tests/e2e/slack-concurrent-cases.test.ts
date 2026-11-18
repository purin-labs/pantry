import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { network } from "./network";
import {
  ROOT_TS,
  SLACK_BOT_TOKEN,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  acceptSlack,
} from "./slack-journey-support";

/**
 * Two Slack threads in one workspace share one Connector. A turn that waits
 * on its model must not hold back the other thread. A second message in the
 * waiting thread never starts a turn beside the first: from the same person,
 * it joins the running turn (Plan 71), and the thread gets one answer that
 * follows both messages.
 */
const TURNS = {
  alphaFirst: { marker: "ALPHA-FIRST", reply: "Alpha first is done." },
  alphaSecond: { marker: "ALPHA-SECOND", reply: "Alpha second is done." },
  bravo: { marker: "BRAVO-ONLY", reply: "Bravo is done." },
} as const;
type TurnName = keyof typeof TURNS;

const BRAVO_TS = "1787500400.000001";

type Model = {
  readonly started: TurnName[];
  readonly releaseAlphaFirst: PromiseWithResolvers<void>;
};

it(
  "runs Slack turns for different Cases at the same time and keeps one Case's messages in order",
  concurrentCasesJourney,
  90_000,
);

async function concurrentCasesJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const model: Model = {
    started: [],
    releaseAlphaFirst: Promise.withResolvers<void>(),
  };
  const delivered: Record<string, string>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, model),
    ),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, delivered),
    ),
  );
  test.onTestFinished(releaseHeldModel.bind(null, model));

  // Thread Alpha opens and its turn waits on the model.
  await acceptSlack({
    eventType: "app_mention",
    eventId: "Ev55E_CONCURRENT_ALPHA_1",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: `<@U0SATYR> ${TURNS.alphaFirst.marker}`,
  });
  await expect
    .poll(startedTurns.bind(null, model), { timeout: 15_000 })
    .toEqual(["alphaFirst"]);

  // Thread Bravo opens while Alpha waits. Its whole turn completes.
  await acceptSlack({
    eventType: "app_mention",
    eventId: "Ev55E_CONCURRENT_BRAVO",
    messageTs: BRAVO_TS,
    threadTs: BRAVO_TS,
    text: `<@U0SATYR> ${TURNS.bravo.marker}`,
  });
  await expect
    .poll(deliveredReplies.bind(null, delivered), { timeout: 15_000 })
    .toEqual([{ threadTs: BRAVO_TS, text: TURNS.bravo.reply }]);
  const startedWhileAlphaWaited = [...model.started];

  // A second Alpha message is accepted but does not start a turn beside the
  // first.
  await acceptSlack({
    eventType: "message",
    eventId: "Ev55E_CONCURRENT_ALPHA_2",
    messageTs: "1787500000.000002",
    threadTs: ROOT_TS,
    text: TURNS.alphaSecond.marker,
  });
  await scheduler.wait(1_500);
  const startedBeforeRelease = [...model.started];
  expect(startedBeforeRelease).toEqual(["alphaFirst", "bravo"]);

  // Alpha's model answers. The second message joined the running turn, so
  // the model then answers it in the same turn, and Alpha gets one answer.
  model.releaseAlphaFirst.resolve();
  await expect
    .poll(deliveredReplies.bind(null, delivered), { timeout: 20_000 })
    .toEqual([
      { threadTs: BRAVO_TS, text: TURNS.bravo.reply },
      {
        threadTs: ROOT_TS,
        text: `${TURNS.alphaFirst.reply}\n\n${TURNS.alphaSecond.reply}`,
      },
    ]);
  expect(model.started).toEqual(["alphaFirst", "bravo", "alphaSecond"]);

  Object.assign(test.task.meta, {
    slackConcurrentCases: {
      modelRequestsWhileAlphaWaited: startedWhileAlphaWaited,
      modelRequestsBeforeAlphaReleased: startedBeforeRelease,
      modelRequests: model.started,
      deliveries: deliveredReplies(delivered),
    },
  });
}

/** A failed run must not leave the held model request waiting. */
function releaseHeldModel(model: Model): void {
  model.releaseAlphaFirst.resolve();
}

function startedTurns(model: Model): readonly TurnName[] {
  return [...model.started];
}

function deliveredReplies(
  delivered: readonly Record<string, string>[],
): readonly { readonly threadTs: string; readonly text: string }[] {
  return delivered.map(deliveredReply);
}

function deliveredReply(message: Record<string, string>): {
  readonly threadTs: string;
  readonly text: string;
} {
  return {
    threadTs: message.thread_ts ?? "",
    text: message.markdown_text ?? message.text ?? "",
  };
}

/** The turn a model request belongs to: the one its newest user message names. */
function requestedTurn(body: unknown): TurnName {
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const users = messages.filter(isUserMessage);
  const latest = JSON.stringify(users.at(-1) ?? null);
  let named: TurnName | null = null;
  let position = -1;
  for (const name of Object.keys(TURNS) as TurnName[]) {
    const found = latest.lastIndexOf(TURNS[name].marker);
    if (found > position) {
      named = name;
      position = found;
    }
  }
  if (named === null) throw new Error("Model request names no known turn");
  return named;
}

function isUserMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "user";
}

async function replyToModel(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const turn = requestedTurn(await request.json());
  model.started.push(turn);
  if (turn === "alphaFirst") await model.releaseAlphaFirst.promise;
  return openRouterText(TURNS[turn].reply, `chatcmpl_55e_concurrent_${turn}`);
}

async function respondToSlack(
  delivered: Record<string, string>[],
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const body: unknown = slackPostFields(await request.json());
  if (!isStringRecord(body)) throw new Error("Slack request body is invalid");
  if (params.method === "chat.postMessage") {
    delivered.push(body);
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787500900.${String(delivered.length).padStart(6, "0")}`,
    });
  }
  return HttpResponse.json({ ok: true });
}
