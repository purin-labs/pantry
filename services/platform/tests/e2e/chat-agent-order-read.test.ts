// An agent that lacks an order read asks for it in a private chat, and a person
// allows it in place. In a shared channel it may not ask, because one click must
// not open customer data to a channel (owner's decision, 2026-11-02).
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { placeCafeOrder, publishCafeMenu } from "./cafe-order-support";
import {
  answers,
  ask,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { connectCommerceFixture } from "./commerce-support";
import {
  createConversation,
  installMemoryFixture,
  workKind,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal, readRequest } from "./permission-request-support";
import {
  installEffectAuthority,
  providerClient,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  discoverSlackChannel,
  installSlackActorFixture,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentOrderRead?: Record<string, unknown>;
  }
}

const MERCHANT_ID = "merchant_chat_order_read";
const BUYER_EMAIL = "buyer-private@example.test";
const ASKED = "I asked for permission to read the orders.";
const CHANNEL_ANSWER = "PI_ORDER_CHANNEL Ask me in a private chat for this.";

type Recorded = {
  readonly requests: Record<string, unknown>[];
  /** The output of each order report that the agent read. */
  readonly reports: string[];
};

/**
 * The owner has an open order in a real shop and no order read for the agent.
 * The owner first allows the commerce context read. Then the owner asks how
 * many orders are open: the report is refused, and the chat pauses on one
 * prompt for the order read instead of telling the owner to find a setting. A
 * resume before the allow is refused. After one allow the same step reads the
 * report, and the count comes from the shop.
 */
it(
  "asks for the order read in a private Portal chat and answers after one allow",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, route, paths } = await installMemoryFixture();
    await connectCommerceFixture(
      author.organisationId,
      author.userId,
      MERCHANT_ID,
    );
    const demo = await providerClient().provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: author.organisationId,
      merchantId: MERCHANT_ID,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    });
    if (!demo.ok) throw new Error(JSON.stringify(demo.error));
    await publishCafeMenu(MERCHANT_ID);
    await placeCafeOrder(MERCHANT_ID);
    const recorded: Recorded = { requests: [], reports: [] };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyInPrivateChat.bind(null, recorded),
      ),
    );

    // The commerce context read comes first, as a workspace owner holds it.
    const setup = newConversationId();
    await createConversation(author, setup, route);
    await ask(author, paths.chat, setup, route.model, "Get ready.", "setup");
    const context = await pausedRequest(author, paths.chat, setup);
    expect(
      (await allowAsPortal(author.organisationId, author.session, context.id))
        .status,
    ).toBe(200);
    expect(
      (await resumeChat(author, paths.chat, setup, context.id)).status,
    ).toBe(200);
    await expect
      .poll(workKind.bind(null, author, setup), { timeout: 60_000 })
      .toBe("ready");

    // 1. The refused report asks for the order read in one prompt.
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);
    await ask(
      author,
      paths.chat,
      conversationId,
      route.model,
      "How many open customer orders do we have?",
      "orders",
    );
    const pause = await pausedRequest(author, paths.chat, conversationId);
    expect(pause.permission).toMatchObject({
      action: "Read customer orders",
      items: [
        {
          kind: "agent_request",
          itemId: "commerce.entity.read:order:requester",
        },
      ],
    });
    expect(await answers(author, conversationId)).not.toContain(ASKED);
    expect(
      await readRequest(author.organisationId, author.session, pause.id),
    ).toMatchObject({
      status: "pending",
      origin: "portal_chat",
      items: [
        {
          capabilityId: "commerce.entity.read",
          granted: false,
          grant: {
            subjectLabel: "Owners",
            target: {
              kind: "commerce_entity_type",
              entityTypeId: { origin: "system", typeId: "order" },
            },
          },
        },
      ],
    });

    // 2. A resume before the allow costs no model step.
    const spent = recorded.requests.length;
    const early = await resumeChat(
      author,
      paths.chat,
      conversationId,
      pause.id,
    );
    expect(early.status).toBe(409);
    expect(recorded.requests).toHaveLength(spent);

    // 3. One allow, and the same step answers with the shop's count.
    const reportsBeforeAllow = recorded.reports.length;
    const allowed = await allowAsPortal(
      author.organisationId,
      author.session,
      pause.id,
    );
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    const resumed = await resumeChat(
      author,
      paths.chat,
      conversationId,
      pause.id,
    );
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await expect
      .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
      .toBe("ready");
    expect(await answers(author, conversationId)).toEqual([
      "There are 1 open customer orders.",
    ]);
    // The answer is the reply: no new step repeats a read that it has no record of.
    expect(recorded.reports).toHaveLength(reportsBeforeAllow + 1);
    expect(recorded.reports.at(-1)).not.toContain(BUYER_EMAIL);

    task.meta.chatAgentOrderRead = {
      request: await readRequest(
        author.organisationId,
        author.session,
        pause.id,
      ),
      earlyResume: early,
      report: recorded.reports.at(-1),
      answers: await answers(author, conversationId),
    };
  },
);

/**
 * The same report in a shared channel: the agent gets a reason that it can
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
      "<@U0SATYR> How many open customer orders do we have?",
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

async function replyInPrivateChat(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const id = `order_read_${String(recorded.requests.length)}`;
  const called = lastCalledTool(body);
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  const offered = offeredToolNames(body);
  const report = (): Response =>
    openRouterToolCall(
      "commerce_merchant_report",
      { request: { name: "open_orders" } },
      `call_${id}`,
    );
  if (called === null) {
    if (JSON.stringify(body.messages).includes("Get ready."))
      if (!JSON.stringify(body.messages).includes("How many open"))
        return openRouterToolCall(
          "request_permission",
          {
            capabilityIds: ["commerce.entity_plane.context"],
            entityTypeReads: [],
          },
          `call_${id}`,
        );
    return offered.includes("commerce_merchant_report")
      ? report()
      : openRouterToolCall(
          "tool_search",
          { query: "commerce_merchant_report", limit: 1 },
          `call_${id}`,
        );
  }
  const output = requireLastToolOutput(body);
  switch (called) {
    case "request_permission":
      return reply("Ready.");
    case "tool_search":
      return report();
    case "commerce_merchant_report": {
      recorded.reports.push(output);
      if (output.includes("Allow prompt")) {
        expect(output).not.toContain("Commerce read denied");
        return reply(ASKED);
      }
      const count = /\\+"value\\+":(\d+)/u.exec(output)?.[1];
      if (count === undefined) throw new Error(`No count in ${output}`);
      // A real model can answer in prose, with no JSON action.
      return openRouterText(`There are ${count} open customer orders.`, id);
    }
    default:
      throw new Error(`Unexpected tool ${called}`);
  }
}

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
