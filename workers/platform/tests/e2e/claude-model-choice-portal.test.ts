import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { preparePortalChatJourney } from "./chat-journey-support";
import { connectAnthropicApiKey } from "./chatgpt-subscription-support";
import { MODEL_EXIT_EGRESS_HEADER } from "./model-exit-network";
import {
  modelIds,
  readChat,
  readWork,
  sendMessage,
} from "./chat-model-choice-support";
import { network } from "./network";

/**
 * An owner chats in Portal on the organisation's own Anthropic API key. The
 * model menu offers Claude Opus 5.5, Sonnet 5.5 and Sonnet 4.6, and a new
 * chat starts on Sonnet 5.5. A message that names no effort runs at medium,
 * which Portal shows as "Balanced". A chat on Opus 5.5 at high effort reaches
 * Anthropic with that model and effort, and keeps Opus 5.5 in its menu. A
 * model that the menu does not offer is refused before any request leaves.
 */
it(
  "offers Claude Opus 5.5 and Sonnet 5.5 in Portal chat and sends the chosen model and effort to Anthropic",
  claudeModelChoiceJourney,
  120_000,
);

const ANTHROPIC_KEY = "sk-ant-api03-e2e-claude-model-choice-0001";
const DEFAULT_CHAT = "conv_4f0c2d8e-2b7a-4c55-9a51-0d6c1c7e5a01";
const OPUS_CHAT = "conv_9b3e61f2-7c4d-4e8a-b0f5-3a2d9e1c6b02";
const UNOFFERED_CHAT = "conv_1d7a5c3b-8e2f-4a69-b4c0-6f5e2d9a8c03";
const REPLY = "Today's pastry orders are summarised.";

async function claudeModelChoiceJourney(test: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const anthropic = new FakeAnthropic(ANTHROPIC_KEY);
  anthropic.install();
  // The chat fixture starts on the Pantry-funded OpenRouter route.
  await connectAnthropicApiKey(ANTHROPIC_KEY);

  const menu = (await readChat(session, null)).model;
  expect(menu).toMatchObject({
    kind: "ready",
    agent: "Claude",
    selected: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
  });
  expect(modelIds(menu)).toEqual([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-sonnet-4-6",
  ]);

  // A new chat on the model that the menu selects. The message names no
  // effort, so the chat takes the default.
  expect(
    await sendMessage(session, {
      conversationId: DEFAULT_CHAT,
      requestId: "request_claude_default",
      model: String(menu.selected),
      text: "Summarise today's pastry orders.",
    }),
  ).toMatchObject({ status: 200 });
  await expect
    .poll(readWork.bind(null, session, DEFAULT_CHAT), { timeout: 30_000 })
    .toBe("ready");
  const defaultChat = await readChat(session, DEFAULT_CHAT);
  expect(JSON.stringify(defaultChat.conversation)).toContain(REPLY);
  expect(defaultChat.conversation).toMatchObject({ effort: "medium" });
  expect(anthropic.requests).toHaveLength(1);
  expect(anthropic.requests[0]?.model).toBe("claude-sonnet-5-5");
  expect(turnEffort(anthropic.requests[0])).toBe("medium");

  // The owner picks Opus 5.5 and "Deep reasoning" for a new chat.
  expect(
    await sendMessage(session, {
      conversationId: OPUS_CHAT,
      requestId: "request_claude_opus",
      model: "claude-opus-5-5",
      effort: "high",
      text: "Plan next week's croissant production.",
    }),
  ).toMatchObject({ status: 200 });
  await expect
    .poll(readWork.bind(null, session, OPUS_CHAT), { timeout: 30_000 })
    .toBe("ready");
  const opusChat = await readChat(session, OPUS_CHAT);
  expect(JSON.stringify(opusChat.conversation)).toContain(REPLY);
  expect(opusChat.model).toMatchObject({
    selected: "claude-opus-5-5",
    name: "Claude Opus 5.5",
  });
  expect(anthropic.requests).toHaveLength(2);
  expect(anthropic.requests[1]?.model).toBe("claude-opus-5-5");
  expect(turnEffort(anthropic.requests[1])).toBe("high");

  // A Claude model that the menu does not offer.
  const unoffered = await sendMessage(session, {
    conversationId: UNOFFERED_CHAT,
    requestId: "request_claude_unoffered",
    model: "claude-haiku-5-5",
    text: "Check the bakery stock.",
  });
  expect(unoffered).toMatchObject({
    status: 422,
    body: { error: "chat_model_invalid" },
  });
  expect(anthropic.requests).toHaveLength(2);

  Object.assign(test.task.meta, {
    claudeModelChoicePortal: {
      menu,
      providerRequests: anthropic.requests.map(requestSummary),
      defaultChatEffort: defaultChat.conversation.effort,
      opusChatMenu: opusChat.model.selected,
      unofferedModel: unoffered,
    },
  });
}

/**
 * A fake Anthropic Messages API for the organisation's own API key. It only
 * records each request and answers it with a Portal reply. Like Anthropic,
 * it refuses a key that it did not issue, and it refuses each request that
 * did not leave through the model exit Worker.
 */
class FakeAnthropic {
  readonly requests: Record<string, unknown>[] = [];

  constructor(readonly apiKey: string) {}

  install(): void {
    network.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        this.respond.bind(this),
      ),
    );
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (!request.headers.has(MODEL_EXIT_EGRESS_HEADER))
      return anthropicError(403, "forbidden", "Request not allowed");
    if (request.headers.get("x-api-key") !== this.apiKey)
      return anthropicError(401, "authentication_error", "invalid x-api-key");
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Messages request body is invalid");
    const id = `msg_e2e_model_choice_${String(this.requests.push(body))}`;
    const text = JSON.stringify({ kind: "reply", text: REPLY });
    const events = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ];
    return new HttpResponse(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
}

function anthropicError(
  status: number,
  type: string,
  message: string,
): Response {
  return HttpResponse.json(
    {
      type: "error",
      error: { type, message },
      request_id: "req_e2e_model_choice",
    },
    { status },
  );
}

/**
 * The effort of the turn that a request asks for. A Claude 5.5 request
 * marks the effort of each turn with a system message; the last marker
 * applies to the answer.
 */
function turnEffort(body: Record<string, unknown> | undefined): unknown {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const marker: unknown = messages.findLast(
    (message: unknown) =>
      isRecord(message) &&
      message.role === "system" &&
      isRecord(message.output_config),
  );
  return isRecord(marker) && isRecord(marker.output_config)
    ? marker.output_config.effort
    : null;
}

function requestSummary(body: Record<string, unknown>): unknown {
  return {
    model: body.model,
    turnEffort: turnEffort(body),
    outputConfig: body.output_config ?? null,
    thinking: body.thinking ?? null,
  };
}
