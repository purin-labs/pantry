// An agent that lacks an order read may not ask for it in a shared channel,
// because one click must not open customer data to a channel (owner's
// decision, 2026-11-02). `chat-agent-order-queue.test.ts` proves the ask and
// the allow in a private Portal chat.
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it } from "vitest";
import { isRecord } from "@seams/std";

import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { lastCalledTool } from "./chat-permission-support";
import { network } from "./network";
import {
  installEffectAuthority,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  slackSimulator,
} from "./slack-journey-support";

const CHANNEL_ANSWER = "PI_ORDER_CHANNEL Ask me in a private chat for this.";

/**
 * An order report in a shared channel: the agent gets a reason that it can
 * tell the person, no request is stored, and the channel sees no prompt.
 */
it(
  "refuses to ask for the order read in a shared channel",
  { timeout: 120_000 },
  async (): Promise<void> => {
    const fixture = await installSlackActorFixture();
    const slack = slackSimulator();
    const steps: ((output: string) => Response)[] = [
      () =>
        openRouterToolCall(
          "tool_search",
          {
            query: "commerce_merchant_report",
            limit: 1,
          },
          "order_channel_search",
        ),
      () =>
        openRouterToolCall(
          "commerce_merchant_report",
          {
            request: { name: "open_orders" },
          },
          "order_channel_report",
        ),
      (output) => {
        expect(output).toContain("shared channel");
        expect(output).not.toContain("Allow prompt");
        return openRouterToolCall(
          "request_permission",
          {
            capabilityIds: [],
            entityTypeReads: ["order"],
          },
          "order_channel_ask",
        );
      },
      (output) => {
        expect(output).toContain("permission_not_requested");
        return openRouterText(CHANNEL_ANSWER, "order_channel_answer");
      },
    ];
    network.use(
      slack.handler,
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyInChannel.bind(null, steps),
      ),
    );
    await installEffectAuthority(
      fixture.selectedIntegrationAccountId,
      "plugin",
    );
    await discoverSlackChannel("public_channel", Date.now() - 60_000);
    const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
    await scope.database
      .prepare(
        "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'order read journey' WHERE organisation_id = ? AND grant_id IN ('grant_pi_read_order', 'grant_pi_channel_order')",
      )
      .bind(ORGANISATION_ID)
      .run();

    await sendListingMessage(
      "app_mention",
      "EvOrderChannel",
      "1710000900.000100",
      "<@U0PANTRY> How many open customer orders do we have?",
      "1710000900.000100",
    );
    await expect
      .poll(() => slack.messages.map((message) => message.text).join("\n"), {
        timeout: 30_000,
      })
      .toContain("PI_ORDER_CHANNEL");
    expect(steps).toEqual([]);
    expect(
      slack.messages.map((message) => JSON.stringify(message)).join("\n"),
    ).not.toContain("Review and allow");
    const stored = await scope.database
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_permission_request WHERE organisation_id = ?",
      )
      .bind(ORGANISATION_ID)
      .first<{ readonly n: number }>();
    expect(stored?.n).toBe(0);
  },
);

async function replyInChannel(
  steps: ((output: string) => Response)[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const step = steps.shift();
  if (step === undefined) throw new Error("Unexpected model request");
  return step(lastCalledTool(body) === null ? "" : requireLastToolOutput(body));
}
