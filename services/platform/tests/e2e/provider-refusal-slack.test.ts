import { env } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  connectAnthropicApiKey,
  sendMention,
  sendReply,
} from "./chatgpt-subscription-support";
import { MODEL_EXIT_EGRESS_HEADER } from "./model-exit-network";
import { network } from "./network";
import {
  installDiscoveryActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
  threadAnswers,
} from "./slack-journey-support";

/**
 * A model provider refuses the first request of a Slack thread at the rate
 * limit. The refusal used no tokens: the thread gets one notice, and the
 * next message in the thread answers on the same route. pi-ai reports an
 * answer only after the provider's SDK accepts it, and the Anthropic and
 * OpenAI SDKs throw on a refusal first. Without its own report of the
 * refusal, the Session would hold a model call with no known usage and
 * block the thread.
 */
it(
  "answers the next message of a Slack thread after Anthropic refuses the organisation's API key at the rate limit",
  refusalSlackJourney.bind(null, "anthropic"),
  120_000,
);

/** The same refusal on the Pantry-funded OpenRouter route of the fixture. */
it(
  "answers the next message of a Slack thread after OpenRouter refuses Satyr's platform key at the rate limit",
  refusalSlackJourney.bind(null, "openrouter"),
  120_000,
);

type RefusingRoute = "anthropic" | "openrouter";

const THREADS: Readonly<
  Record<RefusingRoute, { readonly root: string; readonly reply: string }>
> = {
  anthropic: { root: "1787501300.000001", reply: "1787501300.000002" },
  openrouter: { root: "1787501400.000001", reply: "1787501400.000002" },
};
const ORGANISATION_ANTHROPIC_KEY =
  "sk-ant-api03-e2e-organisation-anthropic-0001";
const ANSWER = "Two integrations answer here.";

async function refusalSlackJourney(
  route: RefusingRoute,
  test: TestContext,
): Promise<void> {
  await installDiscoveryActorFixture();
  const provider =
    route === "anthropic"
      ? new FakeAnthropicApi(ORGANISATION_ANTHROPIC_KEY)
      : new FakeOpenRouter();
  provider.install();
  const slack = slackSimulator();
  network.use(slack.handler);
  // The Slack fixture starts on the Pantry-funded OpenRouter route.
  if (route === "anthropic")
    await connectAnthropicApiKey(ORGANISATION_ANTHROPIC_KEY);

  const thread = THREADS[route].root;
  provider.rateLimitRefusals = 1;
  expect(await sendMention(`Ev_${route}_LIMITED`, thread)).toBe(
    "case_accepted",
  );
  await expect
    .poll(threadAnswers.bind(null, slack.messages, thread), {
      timeout: 30_000,
    })
    .toHaveLength(1);
  const limitNotice = threadAnswers(slack.messages, thread);
  expect(provider.refusedRequests).toBe(1);
  expect(provider.modelRequests).toHaveLength(0);
  expect(
    await sendReply(`Ev_${route}_LIMITED_AGAIN`, THREADS[route].reply, thread),
  ).toBe("case_accepted");
  await expect
    .poll(threadAnswers.bind(null, slack.messages, thread), {
      timeout: 30_000,
    })
    .toEqual([...limitNotice, ANSWER]);

  // The reply made two requests with the same key: the tool call, then the
  // answer. A request with another key is refused, so none is recorded.
  const requests = [...provider.modelRequests];
  expect(requests).toHaveLength(2);
  expect(provider.toolOutput(requests[0]!)).toBeNull();
  expect(provider.toolOutput(requests[1]!)).toContain("integration_ref_");

  Object.assign(test.task.meta, {
    providerRefusalSlack: {
      route,
      refusedRequests: provider.refusedRequests,
      modelRequests: requests.map((body) => ({
        model: body.model,
        toolOutput: provider.toolOutput(body) !== null,
      })),
      answers: threadAnswers(slack.messages, thread),
    },
  });
}

/** What both fake providers record and how a journey steers them. */
interface FakeModelApi {
  readonly modelRequests: readonly Record<string, unknown>[];
  /** The next this many model requests are refused at the rate limit. */
  rateLimitRefusals: number;
  refusedRequests: number;
  install(): void;
  toolOutput(body: Record<string, unknown>): string | null;
}

/**
 * A fake Anthropic Messages API for the organisation's own API key. It only
 * records each request and answers it: a tool call to the integration list
 * first, then a text answer. Like Anthropic, it refuses a key that it did
 * not issue, and it refuses each request that did not leave through the
 * model exit Worker, as Anthropic refuses a region that it does not serve.
 */
class FakeAnthropicApi implements FakeModelApi {
  readonly modelRequests: Record<string, unknown>[] = [];
  rateLimitRefusals = 0;
  refusedRequests = 0;

  constructor(readonly apiKey: string) {}

  install(): void {
    network.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        this.respond.bind(this),
      ),
    );
  }

  toolOutput(body: Record<string, unknown>): string | null {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const message of messages.toReversed()) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content.toReversed())
        if (isRecord(block) && block.type === "tool_result")
          return JSON.stringify(block.content);
    }
    return null;
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (!request.headers.has(MODEL_EXIT_EGRESS_HEADER))
      return anthropicError(403, "forbidden", "Request not allowed");
    if (request.headers.get("x-api-key") !== this.apiKey)
      return anthropicError(401, "authentication_error", "invalid x-api-key");
    if (this.rateLimitRefusals > 0) {
      this.rateLimitRefusals -= 1;
      this.refusedRequests += 1;
      return anthropicError(
        429,
        "rate_limit_error",
        "This request would exceed the rate limit for your organization of 50 requests per minute.",
        { "retry-after": "1" },
      );
    }
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Messages request body is invalid");
    const id = `msg_e2e_refusal_${String(this.modelRequests.push(body))}`;
    const content =
      this.toolOutput(body) === null
        ? {
            type: "tool_use",
            id: `toolu_${id}`,
            name: "integration_list",
            input: {},
          }
        : { type: "text", text: "" };
    const delta =
      content.type === "tool_use"
        ? { type: "input_json_delta", partial_json: "{}" }
        : { type: "text_delta", text: ANSWER };
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
      { type: "content_block_start", index: 0, content_block: content },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: content.type === "tool_use" ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
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
  headers: Record<string, string> = {},
): Response {
  return HttpResponse.json(
    {
      type: "error",
      error: { type, message },
      request_id: "req_e2e_refusal",
    },
    { status, headers },
  );
}

/**
 * A fake OpenRouter Chat Completions API for Pantry's platform key. It only
 * records each request and answers it: a tool call to the integration list
 * first, then a text answer. Like OpenRouter, it refuses a key that it did
 * not issue.
 */
class FakeOpenRouter implements FakeModelApi {
  readonly modelRequests: Record<string, unknown>[] = [];
  rateLimitRefusals = 0;
  refusedRequests = 0;

  install(): void {
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        this.respond.bind(this),
      ),
    );
  }

  toolOutput(body: Record<string, unknown>): string | null {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const output = messages.findLast(
      (message: unknown) => isRecord(message) && message.role === "tool",
    );
    return isRecord(output) ? JSON.stringify(output.content) : null;
  }

  private async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    if (
      request.headers.get("authorization") !==
      `Bearer ${String(env.OPENROUTER_API_KEY)}`
    )
      return HttpResponse.json(
        { error: { code: 401, message: "No auth credentials found" } },
        { status: 401 },
      );
    if (this.rateLimitRefusals > 0) {
      this.rateLimitRefusals -= 1;
      this.refusedRequests += 1;
      return HttpResponse.json(
        {
          error: {
            code: 429,
            message: "Rate limit exceeded: limit_rpm/moonshotai/kimi-k3",
          },
        },
        { status: 429 },
      );
    }
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("OpenRouter request body is invalid");
    const id = `chatcmpl_e2e_refusal_${String(this.modelRequests.push(body))}`;
    return this.toolOutput(body) === null
      ? openRouterToolCall("integration_list", {}, `tool_${id}`)
      : openRouterText(ANSWER, id);
  }
}
