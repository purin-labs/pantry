import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isConversationId, newConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  portalBrowser,
  textsOf,
  type TimelineEvent,
} from "./chat-queued-steer-support";
import { commerceHeaders } from "./commerce-support";
import { network } from "./network";
import {
  controlPaths,
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import {
  openRouterText,
  openRouterToolCall,
  userMessageContaining,
  userMessageIs,
} from "./slack-journey-support";

/**
 * A fork of a steered Portal turn inherits the steering message once (Plan
 * 71).
 *
 * The owner asks for a supplier check, and steers the running turn with a
 * second message. The turn reads the message after its tool result and
 * answers. Its history then holds two messages of the owner in one turn.
 * The owner forks the conversation at that answer and asks a follow-up in
 * the fork. The fork's turn runs: its model request holds the inherited
 * steering message once, after the tool result, and the fork answers.
 */
it(
  "forks a conversation after a steered turn and inherits the steering message once",
  steeringForkJourney,
  120_000,
);

const QUESTION = "Check the next deliveries of our suppliers.";
const STEERING_TEXT = "Only check the flour supplier, not the dairy one.";
const FORK_TEXT = "In this copy, also draft a reminder for Friday.";
const ANSWER = "Checked the flour supplier only: the next delivery is Friday.";
const FORKED = "Drafted a reminder for the Friday flour delivery.";
const FORK_SECOND_TEXT = "Move that reminder to Thursday.";
const FORK_SECOND = "Moved the flour delivery reminder to Thursday.";

type Model = {
  readonly requests: Record<string, unknown>[];
  readonly firstStarted: PromiseWithResolvers<void>;
  readonly releaseFirst: PromiseWithResolvers<void>;
};

async function steeringForkJourney(test: TestContext): Promise<void> {
  const fixture = await installMemoryFixture();
  const owner = fixture.author;
  const model: Model = {
    requests: [],
    firstStarted: Promise.withResolvers<void>(),
    releaseFirst: Promise.withResolvers<void>(),
  };
  test.onTestFinished(releaseHeldModel.bind(null, model));
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, model),
    ),
  );
  const conversationId = newConversationId();
  await createConversation(owner, conversationId, fixture.route);

  // A steered turn: the second message joins it during the first request.
  const started = await message(
    owner,
    conversationId,
    "request_fork_source",
    QUESTION,
    fixture.route.model,
  );
  expect(started.status, await started.clone().text()).toBe(200);
  await model.firstStarted.promise;
  const steered = await post(owner, controlPaths(owner.organisationId).chat, {
    kind: "next",
    conversationId,
    requestId: "request_fork_steer",
    inputId: "input_fork_steer",
    model: fixture.route.model,
    text: STEERING_TEXT,
    surfaceContext: null,
    browserContext: portalBrowser(conversationId),
  });
  expect(steered.status, await steered.clone().text()).toBe(200);
  model.releaseFirst.resolve();
  await expect
    .poll(workKind.bind(null, owner, conversationId), { timeout: 30_000 })
    .toBe("ready");
  expect(model.requests).toHaveLength(2);
  const source = await storedConversation(owner, conversationId);
  expect(textsOf("assistant", source?.conversation.timeline ?? [])).toEqual([
    ANSWER,
  ]);
  expect(textsOf("user", source?.conversation.timeline ?? [])).toEqual([
    QUESTION,
    STEERING_TEXT,
  ]);

  // The owner forks at the steered answer and asks a follow-up there.
  const responseId = source?.conversation.historyBindings.at(-1)?.responseId;
  if (typeof responseId !== "string")
    throw new Error("The steered answer has no history binding");
  const forked = await patchConversation(owner, conversationId, {
    action: "fork",
    operationId: crypto.randomUUID(),
    messageId: responseId,
  });
  expect(forked.status, JSON.stringify(forked.body)).toBe(200);
  const forkId = isRecord(forked.body) ? forked.body.conversationId : null;
  if (!isConversationId(forkId)) throw new Error("The fork has no id");
  const asked = await message(
    owner,
    forkId,
    "request_fork_follow_up",
    FORK_TEXT,
    fixture.route.model,
  );
  expect(asked.status, await asked.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, forkId), { timeout: 30_000 })
    .toBe("ready");

  // The fork's turn holds the inherited steering message once, as its own
  // message after the inherited tool result, and answers. The context of the
  // new request lists the conversation's recent messages, the steering
  // message among them, as it lists the first question.
  expect(model.requests).toHaveLength(3);
  const forkMessages = messageList(model.requests[2]);
  const toolResult = forkMessages.findIndex(isToolMessage);
  const steering = forkMessages.findIndex(
    userMessageIs.bind(null, STEERING_TEXT),
  );
  expect(toolResult).toBeGreaterThan(-1);
  expect(steering).toBeGreaterThan(toolResult);
  expect(
    forkMessages.filter(userMessageIs.bind(null, STEERING_TEXT)),
  ).toHaveLength(1);
  const request = forkMessages.filter(isUserMessage).at(-1);
  expect(userMessageContaining(FORK_TEXT, request)).toBe(true);

  // A second message in the fork restores the fork's own Session and
  // answers.
  const again = await message(
    owner,
    forkId,
    "request_fork_second",
    FORK_SECOND_TEXT,
    fixture.route.model,
  );
  expect(again.status, await again.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, forkId), { timeout: 30_000 })
    .toBe("ready");
  expect(model.requests).toHaveLength(4);
  const fork = await storedConversation(owner, forkId);
  const forkAnswers = textsOf("assistant", fork?.conversation.timeline ?? []);
  expect(forkAnswers).toContain(FORKED);
  expect(forkAnswers).toContain(FORK_SECOND);

  Object.assign(test.task.meta, {
    chatSteeringFork: {
      modelRequests: model.requests.length,
      forkRequestOrder: { toolResult, steering },
      forkTimeline: (fork?.conversation.timeline ?? []).map(function summarise(
        event: TimelineEvent,
      ) {
        return { kind: event.kind, text: event.text ?? null };
      }),
    },
  });
}

function message(
  owner: Member,
  conversationId: string,
  requestId: string,
  text: string,
  model: string,
): Promise<Response> {
  return post(owner, controlPaths(owner.organisationId).chat, {
    kind: "message",
    conversationId,
    requestId,
    model,
    text,
    surfaceContext: null,
    browserContext: portalBrowser(conversationId),
  });
}

async function patchConversation(
  owner: Member,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(
    `https://localhost${controlPaths(owner.organisationId).chat}/conversations/${conversationId}`,
    {
      method: "PATCH",
      headers: commerceHeaders(owner.session),
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: await response.json() };
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
      // The run is busy while this request waits.
      model.firstStarted.resolve();
      await model.releaseFirst.promise;
      return openRouterToolCall(
        "tool_search",
        { query: "supplier deliveries", limit: 1 },
        "call_fork_supplier_search",
      );
    case 2:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: ANSWER }),
        "fork_source_answer",
      );
    case 3:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: FORKED }),
        "fork_answer",
      );
    case 4:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: FORK_SECOND }),
        "fork_second_answer",
      );
    default:
      throw new Error("Unexpected model request");
  }
}

/** A failed run must not leave the held model request waiting. */
function releaseHeldModel(model: Model): void {
  model.releaseFirst.resolve();
}

function messageList(body: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function isToolMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "tool";
}

function isUserMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "user";
}
