import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import {
  portalBrowser,
  textsOf,
  type TimelineEvent,
} from "./chat-queued-steer-support";
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
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  userMessageContaining,
} from "./slack-journey-support";

/**
 * A person steers their running Portal turn, and the turn takes the message
 * without stopping (Plan 71).
 *
 * The owner asks for a supplier check. While the model's first request runs,
 * the owner sends another message with Return, which the Portal sends as a
 * message for the next turn. The turn can take it, so the Session admits it
 * into the running
 * turn: the chat shows the message at once, and the work stays running. The
 * model's first request then asks for a tool. Pi places the message after
 * the tool result, so the model's next request holds both, in that order. The
 * turn ends with one answer that follows the steering message, and nothing
 * was stopped.
 */
it(
  "joins a steering message to the running turn without stopping it",
  steeringJourney,
  120_000,
);

const STEERING_TEXT = "Only check the flour supplier, not the dairy one.";
const ANSWER = "Checked the flour supplier only: the next delivery is Friday.";
const NOTED = "Noted the flour delivery for Friday.";

type Model = {
  readonly requests: Record<string, unknown>[];
  readonly firstStarted: PromiseWithResolvers<void>;
  readonly releaseFirst: PromiseWithResolvers<void>;
};

async function steeringJourney(test: TestContext): Promise<void> {
  const fixture = await installMemoryFixture();
  const owner = fixture.author;
  const model: Model = {
    requests: [],
    firstStarted: Promise.withResolvers<void>(),
    releaseFirst: Promise.withResolvers<void>(),
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, model),
    ),
  );
  const conversationId = newConversationId();
  await createConversation(owner, conversationId, fixture.route);

  const started = await post(owner, controlPaths(owner.organisationId).chat, {
    kind: "message",
    conversationId,
    requestId: "request_supplier_check",
    model: fixture.route.model,
    text: "Check the next deliveries of our suppliers.",
    browserContext: portalBrowser(conversationId),
  });
  expect(started.status, await started.clone().text()).toBe(200);
  await model.firstStarted.promise;

  // The steering message joins the running turn: it shows at once, and the
  // work keeps running.
  const steered = await steer(owner, conversationId, fixture.route.model);
  expect(steered.status, await steered.clone().text()).toBe(200);
  const during = await storedConversation(owner, conversationId);
  expect(during?.conversation.work.kind).toBe("running");
  expect(textsOf("user", during?.conversation.timeline ?? [])).toEqual([
    "Check the next deliveries of our suppliers.",
    STEERING_TEXT,
  ]);

  // The Portal sends the same request again while the turn runs: it adds
  // nothing, also not as a message for the next turn.
  const repeated = await steer(owner, conversationId, fixture.route.model);
  expect(repeated.status, await repeated.clone().text()).toBe(200);
  const retried = await storedConversation(owner, conversationId);
  expect(textsOf("user", retried?.conversation.timeline ?? [])).toHaveLength(2);
  expect(retried?.conversation.pendingInputs).toEqual([]);

  model.releaseFirst.resolve();
  await expect
    .poll(workKind.bind(null, owner, conversationId), { timeout: 30_000 })
    .toBe("ready");

  // One turn: two model requests, the steering message after the tool result
  // in the second, one answer, and no stop.
  expect(model.requests).toHaveLength(2);
  const secondMessages = messageList(model.requests[1]);
  const toolResult = secondMessages.findIndex(isToolMessage);
  const steering = secondMessages.findIndex(
    userMessageContaining.bind(null, STEERING_TEXT),
  );
  expect(toolResult).toBeGreaterThan(-1);
  expect(steering).toBeGreaterThan(toolResult);
  const after = await storedConversation(owner, conversationId);
  const timeline = after?.conversation.timeline ?? [];
  expect(timeline.map(eventKind)).not.toContain("run_cancelled");
  expect(textsOf("assistant", timeline)).toEqual([ANSWER]);
  expect(textsOf("user", timeline)).toEqual([
    "Check the next deliveries of our suppliers.",
    STEERING_TEXT,
  ]);

  // The chat goes on: a new message runs, and its history holds the
  // steering message.
  const next = await post(owner, controlPaths(owner.organisationId).chat, {
    kind: "message",
    conversationId,
    requestId: "request_supplier_thanks",
    model: fixture.route.model,
    text: "Thanks. Note it for Friday.",
    browserContext: portalBrowser(conversationId),
  });
  expect(next.status, await next.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, conversationId), { timeout: 30_000 })
    .toBe("ready");
  expect(model.requests).toHaveLength(3);
  expect(JSON.stringify(model.requests[2])).toContain(STEERING_TEXT);
  const last = await storedConversation(owner, conversationId);
  expect(textsOf("assistant", last?.conversation.timeline ?? [])).toEqual([
    ANSWER,
    NOTED,
  ]);

  Object.assign(test.task.meta, {
    chatNativeSteering: {
      modelRequests: model.requests.length,
      secondRequestOrder: { toolResult, steering },
      timeline: timeline.map(function summarise(event) {
        return {
          kind: event.kind,
          text: "text" in event ? event.text : null,
        };
      }),
    },
  });
}

/** Return while a turn runs: the Portal sends a message for the next turn. */
function steer(owner: Member, conversationId: string, model: string) {
  return post(owner, controlPaths(owner.organisationId).chat, {
    kind: "next",
    conversationId,
    requestId: "request_supplier_steer",
    inputId: "input_supplier_steer",
    model,
    text: STEERING_TEXT,
    browserContext: portalBrowser(conversationId),
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
      // The run is busy while this request waits.
      model.firstStarted.resolve();
      await model.releaseFirst.promise;
      expect(offeredToolNames(body)).toContain("tool_search");
      return openRouterToolCall(
        "tool_search",
        { query: "supplier deliveries", limit: 1 },
        "call_supplier_search",
      );
    case 2:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: ANSWER }),
        "steered_answer",
      );
    case 3:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: NOTED }),
        "next_answer",
      );
    default:
      throw new Error("Unexpected model request");
  }
}

function messageList(body: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function isToolMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "tool";
}

function eventKind(event: TimelineEvent): string {
  return event.kind;
}
