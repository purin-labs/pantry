import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { accessControlPath, mutationHeaders } from "./access-route-support";
import { commerceHeaders } from "./commerce-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  OFFER,
  installEffectAuthority,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackToolCallBudget?: Record<string, unknown>;
  }
}

/**
 * A Slack request that runs out of tool calls in the middle of a Code Mode
 * script.
 *
 * The workspace allows four tool calls for each conversation. The agent's
 * script reads a price six times. The reads after the limit do not run, and
 * the agent is told that the budget is spent, not that the shop's data is
 * unavailable and that it may retry. The thread gets the budget notice with
 * the Portal link where an owner raises the budget. A later message in the
 * same thread gets the same notice and starts no model call.
 */
it(
  "tells the agent and the thread that a conversation used its tool-call budget",
  { timeout: 180_000 },
  toolCallBudgetJourney,
);

const BUDGET_NOTICE =
  "This thread used its budget of tool calls, so Sous Chef cannot answer here any more.";

async function toolCallBudgetJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  await givePortalHandles(ORGANISATION_ID);
  const owner = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "listing",
  );
  await setToolCalls(owner, 4);
  const model = new BudgetModel();
  const slack = slackSimulator();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );

  // 1. The script's reads pass the limit; the agent learns why they stop.
  await sendListingMessage(
    "app_mention",
    "EvToolBudget",
    ROOT_TS,
    "<@U0PANTRY> What does the cookie box cost?",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(1);
  expect(model.scriptOutput).toContain("used its budget of tool calls");
  expect(model.scriptOutput).not.toContain("retry once");
  expect(slack.messages.map(textOf)).toEqual([
    expect.stringContaining(BUDGET_NOTICE),
  ]);
  expect(slack.messages[0]?.text).not.toContain("https:");
  expect(slack.messages[0]?.blocks).toContain("Raise in Portal");
  expect(slack.messages[0]?.blocks).toContain("access?aiBudget=raise");

  // 2. The next message in the thread gets the notice, with no model call.
  const calls = model.calls;
  await sendListingMessage(
    "message",
    "EvToolBudgetAgain",
    "1787500000.000900",
    "<@U0PANTRY> and the box of six?",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(2);
  expect(slack.messages.map(textOf)).toEqual([
    expect.stringContaining(BUDGET_NOTICE),
    expect.stringContaining(BUDGET_NOTICE),
  ]);
  expect(model.calls).toBe(calls);

  task.meta.slackToolCallBudget = {
    substituted: [
      "model provider (deterministic OpenRouter transport)",
      "Slack (signed events)",
    ],
    toolCallLimit: 4,
    scriptOutput: model.scriptOutput,
    slackMessages: slack.messages.map(textOf),
    modelCalls: model.calls,
  };
}

/** Finds the read tool, runs one script of six price reads, then answers. */
class BudgetModel {
  calls = 0;
  scriptOutput = "";

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Invalid model request");
    this.calls += 1;
    switch (this.calls) {
      case 1:
        return openRouterToolCall(
          "tool_search",
          { query: "commerce_entity_context", limit: 1 },
          "budget_discover",
        );
      case 2:
        return openRouterToolCall(
          "codemode",
          { code: sixPriceReads() },
          "budget_reads",
        );
      case 3:
        this.scriptOutput = requireLastToolOutput(body);
        return openRouterText(
          "The thread reached its tool-call budget.",
          "budget_answer",
        );
      default:
        throw new Error("Unexpected model request");
    }
  }
}

function sixPriceReads(): string {
  const request = {
    selection: {
      kind: "entity_seeds",
      seeds: [{ origin: "system", typeId: "offer", entityId: OFFER }],
    },
    traversal: { maxDepth: 0, resultLimit: 1 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [],
    freshnessRequirement: "current_only",
  };
  return `const errors = [];
for (let i = 0; i < 6; i += 1) {
  const read = await tools.commerce_entity_context({ request: ${JSON.stringify(request)} });
  if (!read.ok) errors.push(read.error.message);
}
text(JSON.stringify(errors));`;
}

async function setToolCalls(
  owner: Awaited<ReturnType<typeof installEffectAuthority>>,
  maxToolCalls: number,
): Promise<void> {
  const path = `${accessControlPath(ORGANISATION_ID)}/ai-budget`;
  const read = await exports.default.fetch(path, {
    headers: commerceHeaders(owner),
  });
  const current: unknown = await read.json();
  const revision =
    isRecord(current) && isRecord(current.budget)
      ? current.budget.revision
      : null;
  const saved = await exports.default.fetch(path, {
    method: "POST",
    headers: mutationHeaders(owner),
    body: JSON.stringify({
      expectedRevision: revision,
      limits: { maxTokens: 500_000, maxWallMs: 180_000, maxToolCalls },
    }),
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
}

function textOf(message: Record<string, string>): string {
  return message.text ?? "";
}
