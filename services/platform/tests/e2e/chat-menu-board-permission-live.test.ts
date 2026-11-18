// Plan 40B: the permission tool tells a real model that the board tools need
// commerce.menu_draft.read. The owner has no grant for it. In a Portal chat
// with no page on screen, the owner asks about a saved board. The real model
// (Pantry's OpenRouter route, the production model) finds no board tool, asks
// for the access with the Allow prompt, and after Allow reads the board and
// answers with its content. Only Slack-free control routes and the model
// network are real; the run is skipped without SATYR_PI_ACCEPTANCE_API_KEY.
//
// Run:
//   SATYR_PI_ACCEPTANCE_API_KEY=<OpenRouter key> SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker> \
//   ./node_modules/.bin/vitest run --config vitest.e2e.config.ts tests/e2e/chat-menu-board-permission-live.test.ts
import { env } from "cloudflare:workers";
import { bypass, http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import { answers, ask, pausedRequest, resumeChat } from "./chat-permission-support";
import { createConversation, installMemoryFixture, postJson, workKind } from "./memory-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import { connectCommerceFixture } from "./commerce-support";
import { providerClient } from "./pi-sdk-effect-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardPermissionLive?: Record<string, unknown>;
  }
}

const BOARD = "Window specials";
const MERCHANT_ID = "merchant_board_permission_live";

type ModelCall = Readonly<{ model: string; tools: readonly string[]; called: readonly string[] }>;

it.skipIf(env.OPENROUTER_API_KEY === "openrouter-e2e-key")(
  "lets a real model ask for the menu draft read before it reads a board that is not on screen",
  { timeout: 600_000 },
  async ({ task }: TestContext): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, paths } = fixture;
    // The owner's café shop, as in production.
    await connectCommerceFixture(author.organisationId, author.userId, MERCHANT_ID);
    const demo = await providerClient().provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: author.organisationId,
      merchantId: MERCHANT_ID,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    });
    if (!demo.ok) throw new Error(JSON.stringify(demo.error));
    const calls: ModelCall[] = [];
    network.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", forward.bind(null, calls)),
    );

    // The owner makes a board from the two-column template: a heading with
    // its name, the menu sections and the order QR code.
    const created = await postJson(author, `${paths.organisation}/menu-boards`, {
      title: BOARD,
      layout: "two_columns",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // The owner asks in a chat with no page on screen.
    const conversationId = newConversationId();
    await createConversation(author, conversationId, fixture.route);
    await ask(
      author,
      paths.chat,
      conversationId,
      fixture.route.model,
      `What does the saved "${BOARD}" menu board show? Read the saved board. Change nothing.`,
      "board",
    );
    // The owner allows each request, as the Portal's prompt does, and the
    // chat goes on. The first request must name the menu draft read.
    const requests: Readonly<{ id: string; items: readonly string[]; action: unknown }>[] = [];
    let kind = "";
    while (requests.length < 4) {
      await expect
        .poll(async () => (kind = (await workKind(author, conversationId)) ?? ""), { timeout: 240_000, interval: 1_000 })
        .toMatch(/^(awaiting_permission|ready)$/u);
      if (kind === "ready") break;
      const pause = await pausedRequest(author, paths.chat, conversationId, requests.at(-1)?.id ?? null);
      requests.push({
        id: pause.id,
        action: pause.permission.action ?? null,
        items: Array.isArray(pause.permission.items)
          ? pause.permission.items.flatMap((item: unknown) =>
              isRecord(item) && typeof item.itemId === "string" ? [item.itemId] : [])
          : [JSON.stringify(pause.permission)],
      });
      const allowed = await allowAsPortal(author.organisationId, author.session, pause.id);
      expect(allowed.status, await allowed.clone().text()).toBe(200);
      const resumed = await resumeChat(author, paths.chat, conversationId, pause.id);
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    }
    expect(kind, JSON.stringify(requests)).toBe("ready");
    expect(requests[0]?.items ?? [], JSON.stringify(requests)).toContain("commerce.menu_draft.read");
    const said = await answers(author, conversationId);
    const answer = said.at(-1) ?? "";
    const boardReads = calls.filter((call) => call.called.includes("menu_board_read")).length;
    expect(boardReads, JSON.stringify(calls)).toBeGreaterThan(0);
    expect(answer).toContain(BOARD);

    task.meta.menuBoardPermissionLive = {
      substituted: [],
      real: ["Satyr Worker and the Portal chat routes", "OpenRouter with Satyr's production model"],
      models: [...new Set(calls.map((call) => call.model))],
      requests: requests.map((request) => ({ action: request.action, items: request.items })),
      toolsCalled: calls.flatMap((call) => call.called),
      boardReadOfferedBeforeAllow: calls.some((call, index) =>
        index <= calls.findIndex((later) => later.called.includes("request_permission")) &&
        call.tools.includes("menu_board_read")),
      answerNamesBoard: answer.includes(BOARD),
      answers: said.length,
    };
  },
);

/** Sends each model request to OpenRouter and records which tools it offered and called. */
async function forward(
  calls: ModelCall[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body = await request.text();
  const parsed: unknown = JSON.parse(body);
  const response = await fetch(bypass(request.url, { method: "POST", headers: request.headers, body }));
  if (!response.ok) throw new Error(`OpenRouter status ${response.status}`);
  const stream = await response.clone().text();
  calls.push({
    model: isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : "",
    tools: isRecord(parsed) && Array.isArray(parsed.tools)
      ? parsed.tools.flatMap((tool: unknown) =>
          isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : [])
      : [],
    called: calledTools(stream),
  });
  return response;
}

/** The tool names that a streamed answer calls. */
function calledTools(stream: string): string[] {
  const names: string[] = [];
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const value: unknown = JSON.parse(line.slice(6));
      const choices = isRecord(value) && Array.isArray(value.choices) ? value.choices : [];
      for (const choice of choices) {
        const calls = isRecord(choice) && isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls)
          ? choice.delta.tool_calls
          : [];
        for (const call of calls)
          if (isRecord(call) && isRecord(call.function) && typeof call.function.name === "string")
            names.push(call.function.name);
      }
    } catch {
      continue;
    }
  }
  return names;
}
