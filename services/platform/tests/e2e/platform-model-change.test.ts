import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { controlFetch, preparePortalChatJourney } from "./chat-journey-support";
import { network } from "./network";
import { ORGANISATION_ID, openRouterText } from "./slack-journey-support";

/**
 * A Portal chat keeps working when a release changes the default model of
 * Pantry's paid route (spec FND-04).
 *
 * Before the release, the route runs Kimi K3, and an owner's chat gets an
 * answer from it. The release changes the default to Gemini 4 Hydrogen. The
 * same chat then opens with Gemini 4 Hydrogen in its model menu, not with a
 * request to connect an AI provider. A message from a page that was loaded
 * before the release still names Kimi K3; it gets one answer, from Gemini 4
 * Hydrogen. A message that names a model the route does not run is refused
 * before any model request.
 */
it(
  "moves an open Portal chat to the new default model of the paid route",
  modelChangeJourney,
  120_000,
);

const EARLIER_DEFAULT = "moonshotai/kimi-k3";
const CONVERSATION_ID = "conv_5d3f1e2a-7b4c-4c8e-9a6f-2e1d0c9b8a71";

type Model = { readonly requests: Record<string, unknown>[] };

async function modelChangeJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const model: Model = { requests: [] };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      answerModel.bind(null, model),
    ),
  );

  // Before the release: the paid route runs the earlier default.
  env.PANTRY_PLATFORM_PI_MODEL = EARLIER_DEFAULT;
  test.onTestFinished(() => {
    delete env.PANTRY_PLATFORM_PI_MODEL;
  });
  expect(await shownModel(session)).toEqual({
    selected: EARLIER_DEFAULT,
    name: "Kimi K3",
  });
  expect((await send(session, 1, EARLIER_DEFAULT)).status).toBe(200);
  await answered(session, "ANSWER_1");
  expect(model.requests.map(requestedModel)).toEqual([EARLIER_DEFAULT]);

  // The release: the variable is gone, and the code default applies.
  delete env.PANTRY_PLATFORM_PI_MODEL;
  expect(await shownModel(session)).toEqual({
    selected: PLATFORM_DEFAULT_PI_MODEL,
    name: "Gemini 4 Hydrogen",
  });

  // A page from before the release still names the earlier default.
  expect((await send(session, 2, EARLIER_DEFAULT)).status).toBe(200);
  await answered(session, "ANSWER_2");
  expect(model.requests.map(requestedModel)).toEqual([
    EARLIER_DEFAULT,
    PLATFORM_DEFAULT_PI_MODEL,
  ]);

  // A model that the route does not run is refused, and no request leaves.
  const refused = await send(session, 3, "anthropic/claude-opus-5-5");
  expect(refused.status).toBe(422);
  expect(errorOf(await refused.json())).toBe("chat_model_invalid");
  expect(model.requests).toHaveLength(2);

  Object.assign(test.task.meta, {
    platformModelChange: {
      before: EARLIER_DEFAULT,
      after: PLATFORM_DEFAULT_PI_MODEL,
      requests: model.requests.map(requestedModel),
      refusedModel: "chat_model_invalid",
    },
  });
}

async function answerModel(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("model request is not an object");
  model.requests.push(body);
  const index = model.requests.length;
  return openRouterText(
    JSON.stringify({ kind: "reply", text: `ANSWER_${String(index)}` }),
    `model_change_${String(index)}`,
  );
}

function requestedModel(body: Record<string, unknown>): unknown {
  return body.model;
}

function send(
  session: IssuedControlSession,
  turn: number,
  modelId: string,
): Promise<Response> {
  return controlFetch(ORGANISATION_ID, session, "chat", {
    kind: "message",
    conversationId: CONVERSATION_ID,
    requestId: `request_model_change_${String(turn)}`,
    model: modelId,
    text: `How many croissants are left? (${String(turn)})`,
  });
}

async function readChat(
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  const response = await controlFetch(
    ORGANISATION_ID,
    session,
    `chat?conversation=${CONVERSATION_ID}`,
    null,
  );
  const body: unknown = await response.json();
  if (response.status !== 200 || !isRecord(body))
    throw new Error(`chat read failed: ${JSON.stringify(body)}`);
  return body;
}

/** The model that the chat's menu shows. */
async function shownModel(
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  const body = await readChat(session);
  const shown = body.model;
  if (!isRecord(shown) || shown.kind !== "ready")
    return { unavailable: isRecord(shown) ? shown.message : shown };
  return { selected: shown.selected, name: shown.name };
}

/** Waits until the chat is at rest with an answer that holds `text`. */
async function answered(
  session: IssuedControlSession,
  text: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const conversation = (await readChat(session)).conversation;
        if (!isRecord(conversation) || !isRecord(conversation.work))
          return "missing";
        const answers = JSON.stringify(conversation.timeline ?? null);
        return conversation.work.kind === "ready" && answers.includes(text)
          ? "answered"
          : String(conversation.work.kind);
      },
      { timeout: 60_000, interval: 250 },
    )
    .toBe("answered");
}

function errorOf(body: unknown): unknown {
  return isRecord(body) ? body.error : null;
}
