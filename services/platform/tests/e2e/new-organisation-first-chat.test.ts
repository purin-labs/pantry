import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import {
  CONVERSATION_ID,
  preparePortalChatJourney,
  toolOutput,
} from "./chat-journey-support";
import { readChat, sendMessage } from "./chat-model-choice-support";
import { network } from "./network";
import {
  openRouterText,
  openRouterToolCall,
  openRouterUsage,
  type OpenRouterUsage,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    newOrganisationFirstChat?: Record<string, unknown>;
  }
}

/**
 * A new Organisation's first Portal chat turn with tool calls gets an answer
 * under the AI budget that the Organisation gets when it is created.
 *
 * On 22 November 2026 the first chat turn of a new Organisation on
 * pantry.purin.io used 71,114 tokens: three model calls on the route that
 * Purin pays for, each with the instructions and the tool catalogue, and two
 * tool calls between them. The default budget of 64,000 tokens stopped the
 * turn with "This session reached its token limit". Here the model reports
 * the same usage, and the journey does not change the budget. The owner asks
 * what the agent can do; the agent finds the integration tool, lists the
 * connected apps, and answers.
 */
it(
  "answers the first chat turn with tool calls of a new Organisation",
  { timeout: 120_000 },
  firstChatJourney,
);

const ANSWER =
  "I can help with products, menus, recipes, orders and stock. Slack is connected.";

/** The model calls of the turn, in order: 71,114 tokens in all. */
const USAGE: readonly OpenRouterUsage[] = [
  openRouterUsage(22_840, 0, 412),
  openRouterUsage(23_310, 22_528, 286),
  openRouterUsage(23_702, 23_040, 564),
];

type Model = { readonly requests: Record<string, unknown>[] };

async function firstChatJourney({ task }: TestContext): Promise<void> {
  const { session } = await preparePortalChatJourney();
  const model: Model = { requests: [] };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      answerModel.bind(null, model),
    ),
  );

  const sent = await sendMessage(session, {
    conversationId: CONVERSATION_ID,
    requestId: "request_new_organisation_first_chat",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "What can you do for my shop, and which apps are connected?",
  });
  expect(sent.status).toBe(200);
  await expect
    .poll(turnOutcome.bind(null, session), { timeout: 60_000, interval: 250 })
    .toBe("answered");

  // The turn ran both tools: each later model call holds the result of the
  // tool before it, and the integration list names the Slack workspace.
  expect(model.requests).toHaveLength(USAGE.length);
  expect(model.requests.map(requestedModel)).toEqual(
    USAGE.map(() => PLATFORM_DEFAULT_PI_MODEL),
  );
  const outputs = model.requests.map(toolOutput);
  expect(outputs[1]).toContain("integration_list");
  expect(outputs[2]?.toLowerCase()).toContain("slack");

  Object.assign(task.meta, {
    newOrganisationFirstChat: {
      model: PLATFORM_DEFAULT_PI_MODEL,
      modelCalls: model.requests.length,
      tokensReported: USAGE.reduce(sumTokens, 0),
      tools: ["tool_search", "integration_list"],
      answer: ANSWER,
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
  const call = model.requests.length;
  const usage = USAGE[call - 1];
  if (usage === undefined) throw new Error(`unexpected model call ${call}`);
  switch (call) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: 5 },
        "first_chat_search",
        usage,
      );
    case 2:
      return openRouterToolCall(
        "integration_list",
        {},
        "first_chat_integrations",
        usage,
      );
    default:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: ANSWER }),
        "first_chat_answer",
        usage,
      );
  }
}

/**
 * "answered" when the chat is at rest with the answer. A failed turn gives
 * its message, so that a stopped turn shows the limit that stopped it.
 */
async function turnOutcome(session: IssuedControlSession): Promise<string> {
  const { conversation } = await readChat(session, CONVERSATION_ID);
  const work = conversation.work;
  if (!isRecord(work)) return "missing";
  if (work.kind === "failed") return `failed: ${JSON.stringify(work)}`;
  return work.kind === "ready" &&
    JSON.stringify(conversation.timeline ?? null).includes(ANSWER)
    ? "answered"
    : String(work.kind);
}

function requestedModel(body: Record<string, unknown>): unknown {
  return body.model;
}

function sumTokens(total: number, usage: OpenRouterUsage): number {
  return total + usage.total_tokens;
}
