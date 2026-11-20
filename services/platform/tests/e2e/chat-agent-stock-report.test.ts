// The agent's stock shortage report counts the same rows as the Products and
// Ingredients pages: an item with no stock is short, with or without a reorder
// point (owner's decision, 2026-11-03).
import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { parseInventory } from "@purin-labs/commerce-contracts";
import { newConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import {
  answers,
  ask,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { commerceHeaders, connectCommerceFixture } from "./commerce-support";
import {
  createConversation,
  installMemoryFixture,
  workKind,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import { providerClient } from "./pi-sdk-effect-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentStockReport?: Record<string, unknown>;
  }
}

const MERCHANT_ID = "merchant_chat_stock_report";

/**
 * The owner of a café shop asks the Portal chat agent which stock is short.
 * The stock pages show items at zero, most of them with no reorder point. The
 * agent's report gives the same number as the pages, after one allow of the
 * stock read when the owner does not hold it yet.
 */
it(
  "reports the same stock shortages as the Products and Ingredients pages",
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
    const reports: string[] = [];
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyAboutStock.bind(null, reports),
      ),
    );

    // What the Products and Ingredients pages count as shortages.
    const page = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${author.organisationId}/commerce/inventory`,
      { headers: commerceHeaders(author.session) },
    );
    expect(page.status, await page.clone().text()).toBe(200);
    const shortages = parseInventory(await page.json()).rows.filter(
      (row) => row.status === "low" || row.status === "out",
    );
    expect(shortages.length).toBeGreaterThan(0);
    // A row with no reorder point has no flag in the graph, so only a count
    // of the stock rows can include it.
    expect(shortages.some((row) => row.reorderPoint === null)).toBe(true);

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

    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);
    await ask(
      author,
      paths.chat,
      conversationId,
      route.model,
      "Which stock is short?",
      "stock",
    );
    await expect
      .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
      .toMatch(/^(ready|awaiting_permission)$/u);
    let allowed = false;
    if ((await workKind(author, conversationId)) === "awaiting_permission") {
      const pause = await pausedRequest(author, paths.chat, conversationId);
      expect(
        (await allowAsPortal(author.organisationId, author.session, pause.id))
          .status,
      ).toBe(200);
      expect(
        (await resumeChat(author, paths.chat, conversationId, pause.id)).status,
      ).toBe(200);
      await expect
        .poll(workKind.bind(null, author, conversationId), {
          timeout: 60_000,
        })
        .toBe("ready");
      allowed = true;
    }
    expect(await answers(author, conversationId)).toEqual([
      `${String(shortages.length)} stock items are short.`,
    ]);

    task.meta.chatAgentStockReport = {
      pageShortages: shortages.map((row) => `${row.name}: ${row.status}`),
      allowedStockRead: allowed,
      report: reports.at(-1),
      answers: await answers(author, conversationId),
    };
  },
);

async function replyAboutStock(
  reports: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const id = `stock_report_${String(reports.length)}_${crypto.randomUUID()}`;
  const called = lastCalledTool(body);
  const report = (): Response =>
    openRouterToolCall(
      "commerce_merchant_report",
      { request: { name: "low_stock_exposure" } },
      `call_${id}`,
    );
  if (called === null) {
    const messages = JSON.stringify(body.messages);
    if (messages.includes("Get ready.") && !messages.includes("stock is short"))
      return openRouterToolCall(
        "request_permission",
        {
          capabilityIds: ["commerce.entity_plane.context"],
          entityTypeReads: [],
        },
        `call_${id}`,
      );
    return offeredToolNames(body).includes("commerce_merchant_report")
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
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "Ready." }),
        id,
      );
    case "tool_search":
      return report();
    case "commerce_merchant_report": {
      reports.push(output);
      if (output.includes("Allow prompt"))
        return openRouterText("I asked to read the stock.", id);
      const count = /\\+"value\\+":(\d+)/u.exec(output)?.[1];
      if (count === undefined) throw new Error(`No count in ${output}`);
      return openRouterText(`${count} stock items are short.`, id);
    }
    default:
      throw new Error(`Unexpected tool ${called}`);
  }
}
