import { exports } from "cloudflare:workers";
import { delay, http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import { accessControlPath, mutationHeaders } from "./access-route-support";
import { commerceHeaders } from "./commerce-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  openRouterStream,
  openRouterText,
  openRouterToolCall,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

declare module "vitest" {
  interface TaskMeta {
    slackTurnTimeLimit?: Record<string, unknown>;
  }
}

/**
 * The AI budget limits the time of each request and the tokens of a whole
 * thread. In one thread, two requests whose times add up to more than the
 * limit both answer. A request whose first model call returns after the
 * limit makes no second call: it ends with a notice that says so, and the
 * next request in the same thread answers with that history. A reply that
 * the model cuts off at its length limit ends the same way. After a request
 * that the provider rejects, the next request answers too. In a second
 * thread, the requests use up the token budget: the request that crosses it,
 * and every later one, get a notice with the Portal link where an owner
 * raises the budget, and no generic failure text.
 */
it(
  "limits the time of each request and the tokens of a whole thread, and keeps a thread going after a request that stopped early",
  timeLimitJourney,
  240_000,
);

const TOKEN_THREAD_TS = "1787500200.000001";
const TIME_LIMIT_MS = 6_000;
const TIME_NOTICE =
  "Sous Chef stopped this request at the time limit for one request. Ask again to continue, in smaller steps if you can.";
const TOKEN_NOTICE =
  "This thread used its AI token budget, so Sous Chef cannot answer here any more.";
const GENERIC_FAILURE = "Sous Chef couldn’t complete this request. Please try again.";
const UNFINISHED_NOTICE =
  "Sous Chef could not finish this answer. Ask again to continue.";
const PROVIDER_FAILURE_NOTE =
  "The model provider failed, so Sous Chef could not complete this request.";
/** How long the model takes to answer each request, by its marker. */
const MODEL_DELAY_MS: Readonly<Record<string, number>> = {
  "first slow step": 3_500,
  "second slow step": 3_500,
  "a step that is far too slow": 7_500,
  "a quick step": 0,
  "a step the model cuts off": 0,
  "a step the provider rejects": 0,
  "one more quick step": 0,
};

async function timeLimitJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await givePortalHandles(ORGANISATION_ID);
  const slack = slackSimulator();
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", replyToModel),
    slack.handler,
  );

  // 1. Each request may run for six seconds; a thread has many tokens.
  await setBudget(owner, {
    maxTokens: 1_000_000,
    maxWallMs: TIME_LIMIT_MS,
    maxToolCalls: 20,
  });

  // 2. Two slow requests in one thread answer, though together they run
  //    longer than the limit.
  await ask("Ev_TIME_1", ROOT_TS, ROOT_TS, "first slow step");
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(1);
  await ask("Ev_TIME_2", "1787500000.000002", ROOT_TS, "second slow step");
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(textsOf(slack.messages)).toEqual([
    "Answered: first slow step",
    "Answered: second slow step",
  ]);

  // 3. The first model call of a request returns a tool call after the
  //    limit. The turn makes no second call and ends with the time notice.
  await ask(
    "Ev_TIME_3",
    "1787500000.000003",
    ROOT_TS,
    "a step that is far too slow",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(3);
  // A notice of a sentence or more streams: it shows its first part first.
  await expect.poll(() => textsOf(slack.messages)[2]).toBe(TIME_NOTICE);
  expect(modelCalls["a step that is far too slow"]).toBe(1);

  // 4. The thread goes on: the next request answers, and the model sees the
  //    stopped request and its notice in the history.
  await ask("Ev_TIME_4", "1787500000.000004", ROOT_TS, "a quick step");
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(4);
  expect(textsOf(slack.messages)[3]).toBe("Answered: a quick step");
  expect(historyOfQuickStep).toContain(TIME_NOTICE);

  // 5. The model cuts its reply off at its length limit. The thread gets
  //    the part it wrote and a notice, and the next request answers.
  await ask(
    "Ev_TIME_5",
    "1787500000.000005",
    ROOT_TS,
    "a step the model cuts off",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(5);
  await expect
    .poll(() => textsOf(slack.messages)[4])
    .toBe(`Half of an answer\n\n${UNFINISHED_NOTICE}`);

  // 6. The provider rejects a request. The thread gets the failure text,
  //    and the next request answers with the rejected request and a note
  //    about the failure in its history.
  await ask(
    "Ev_TIME_6",
    "1787500000.000006",
    ROOT_TS,
    "a step the provider rejects",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(6);
  expect(textsOf(slack.messages)[5]).toBe(GENERIC_FAILURE);
  await ask("Ev_TIME_7", "1787500000.000007", ROOT_TS, "one more quick step");
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(7);
  expect(textsOf(slack.messages)[6]).toBe("Answered: one more quick step");
  expect(historyOfLastStep).toContain("a step the provider rejects");
  expect(historyOfLastStep).toContain(PROVIDER_FAILURE_NOTE);

  // 7. A new thread with a small token budget: each model call uses 25
  //    tokens, so the third request crosses 60.
  await setBudget(owner, {
    maxTokens: 60,
    maxWallMs: TIME_LIMIT_MS,
    maxToolCalls: 20,
  });
  // Each request waits for its answer, so no two requests share a turn.
  for (const [index, ts] of [
    TOKEN_THREAD_TS,
    "1787500200.000002",
    "1787500200.000003",
    "1787500200.000004",
  ].entries()) {
    await ask(`Ev_TOKENS_${String(index)}`, ts, TOKEN_THREAD_TS, "a quick step");
    await expect
      .poll(slack.visibleMessageCount, { timeout: 60_000 })
      .toBe(8 + index);
  }
  const tokenMessages = slack.messages.filter(
    (message) => message.thread_ts === TOKEN_THREAD_TS,
  );
  const tokenThread = textsOf(tokenMessages);
  expect(tokenThread.slice(0, 2)).toEqual([
    "Answered: a quick step",
    "Answered: a quick step",
  ]);
  for (const notice of tokenMessages.slice(2)) {
    expect(notice.text).toContain(TOKEN_NOTICE);
    expect(notice.text).not.toContain("https:");
    expect(notice.blocks).toContain("/access?aiBudget=raise");
  }
  expect(tokenThread).not.toContain(GENERIC_FAILURE);

  task.meta.slackTurnTimeLimit = {
    timeThread: textsOf(slack.messages).slice(0, 7),
    tokenThread,
  };
}

const modelCalls: Record<string, number> = {};
let historyOfQuickStep = "";
let historyOfLastStep = "";

async function replyToModel({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const marker = currentRequestMarker(body);
  modelCalls[marker] = (modelCalls[marker] ?? 0) + 1;
  if (marker === "a quick step" && historyOfQuickStep === "")
    historyOfQuickStep = JSON.stringify(body.messages);
  if (marker === "one more quick step")
    historyOfLastStep = JSON.stringify(body.messages);
  await delay(MODEL_DELAY_MS[marker] ?? 0);
  // The slow request asks for a tool, so it needs a second model call.
  if (marker === "a step that is far too slow")
    return openRouterToolCall(
      "tool_search",
      { query: "menu" },
      "call_time_tool_search",
    );
  if (marker === "a step the provider rejects")
    return Response.json(
      { error: { message: "Synthetic provider rejection", code: 400 } },
      { status: 400 },
    );
  if (marker === "a step the model cuts off")
    return openRouterStream([
      {
        id: "time_cut_off",
        object: "chat.completion.chunk",
        created: 1_787_500_000,
        model: PLATFORM_DEFAULT_PI_MODEL,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Half of an answer" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "time_cut_off",
        object: "chat.completion.chunk",
        created: 1_787_500_000,
        model: PLATFORM_DEFAULT_PI_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);
  return openRouterText(`Answered: ${marker}`, `time_${marker.length}`);
}

/** The marker of the person's current request, not of earlier context. */
function currentRequestMarker(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = JSON.stringify(messages.at(-1) ?? null);
  const current = text.slice(text.lastIndexOf("Current request:"));
  const marker = Object.keys(MODEL_DELAY_MS).find((candidate) =>
    current.includes(candidate),
  );
  if (marker === undefined) throw new Error("Unexpected model request");
  return marker;
}

async function setBudget(
  session: IssuedControlSession,
  limits: Readonly<{ maxTokens: number; maxWallMs: number; maxToolCalls: number }>,
): Promise<void> {
  const path = `${accessControlPath(ORGANISATION_ID)}/ai-budget`;
  const read = await exports.default.fetch(path, {
    headers: commerceHeaders(session),
  });
  expect(read.status, await read.clone().text()).toBe(200);
  const current: unknown = await read.json();
  const revision =
    isRecord(current) && isRecord(current.budget) ? current.budget.revision : null;
  const saved = await exports.default.fetch(path, {
    method: "POST",
    headers: mutationHeaders(session),
    body: JSON.stringify({ expectedRevision: revision, limits }),
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
}

async function ask(
  eventId: string,
  messageTs: string,
  threadTs: string,
  question: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs,
        threadTs,
        text: `<@U0PANTRY> ${question}`,
      }),
    ),
  );
  expect(response.status).toBe(200);
}

function textsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map((message) => message.text ?? "");
}
