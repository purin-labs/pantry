// Plan 87 J5: the agent runs a view command on Costs & margins in the
// person's browser. The command reaches only the page that the person's
// message carried, and the receipt gives the agent the page as it now is.
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  COSTS_VIEW_COMMANDS,
  newConversationId,
  type ConversationId,
  type SurfaceObservationV2,
} from "@seams/control-api";
import {
  createBakerySurfaceReceipt,
  parseBakerySurfaceEffect,
  type BakerySurfaceEffectV1,
} from "@seams/bakery-model/bakery-surface";
import { isRecord } from "@seams/std";
import { env } from "cloudflare:workers";

import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  createConversation,
  installMemoryFixture,
  post,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";
import { finished, lastToolCallName } from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatCostsCommands?: Record<string, unknown>;
  }
}

const BROWSER = "browser-j5";
const PRODUCT_ID = "prod_matcha_financier";

/** Costs & margins as a new tab sends it, with its view commands. */
function costsObservation(selected: string): SurfaceObservationV2 {
  return {
    kind: "surface-observation",
    schemaVersion: 2,
    surface: "costs",
    area: "BakeryOS",
    instance: {
      browserInstanceId: BROWSER,
      surfaceSessionId: "costs-session-j5",
      epoch: 0,
    },
    title: "Costs & margins",
    path: "/portal/nuki/shop/costs",
    record: null,
    capturedAt: Date.now(),
    view: [
      {
        title: "Page state",
        facts: [
          { label: "Open tab", value: "1. Product Margins" },
          { label: "Selected product", value: selected },
        ],
        table: null,
      },
      {
        title: "Product margins table (rows in view)",
        facts: [],
        table: {
          columns: ["Product id", "Product", "Net margin"],
          rows: [
            [PRODUCT_ID, "Matcha financier", "58.4%"],
            ["prod_black_sesame_latte", "Black sesame latte", "61.3%"],
          ],
          totalRows: 2,
        },
      },
    ],
    state: null,
    commands: [...COSTS_VIEW_COMMANDS],
    sources: [],
  };
}

type Model = { requests: string[]; toolResults: string[] };

/**
 * Plan 87 J5. The owner asks the agent to show the Matcha financier on
 * Costs. The agent's command reaches the owner's browser, which answers
 * with the page as it now shows it; the agent reads that observation. A
 * message that carried no Costs page gets no command: the tool refuses, and
 * no command reaches the browser.
 */
it(
  "runs a Costs view command in the person's browser only for a page that the message carried",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, route, paths } = await installMemoryFixture();
    const model: Model = { requests: [], toolResults: [] };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        selectProduct.bind(null, model),
      ),
    );
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);

    const sent = await send(author, paths.chat, conversationId, route.model, {
      label: "show",
      text: "Show me the Matcha financier on my screen.",
      surfaceObservation: costsObservation("None"),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const effect = await pendingPageCommand(author, paths.chat, conversationId);
    if (effect.command.kind !== "page_command")
      throw new Error("Expected a page command");
    expect(effect.command).toMatchObject({
      surface: "costs",
      target: { surfaceSessionId: "costs-session-j5", epoch: 0 },
      command: { name: "select_product", productId: PRODUCT_ID },
      binding: { browserInstanceId: BROWSER, conversationId },
    });
    expect(effect.command.agentLabel.length).toBeGreaterThan(0);
    // The browser runs the command and answers with what the page shows now.
    const receipt = await createBakerySurfaceReceipt(effect, {
      kind: "page_completed",
      observation: costsObservation("Matcha financier"),
    });
    const settled = await post(
      author,
      `${paths.chat}/surface-effects/${effect.effectId}/receipt`,
      { receipt },
    );
    expect(settled.status, await settled.clone().text()).toBe(200);
    await finished(author, conversationId);
    const shownResult = model.toolResults.at(-1) ?? "";
    expect(shownResult).toContain("page_completed");
    expect(shownResult).toContain("Selected product");
    expect(shownResult).toContain("Matcha financier");
    const read = await post(
      author,
      `${paths.chat}?conversation=${conversationId}`,
      null,
    );
    const timeline = JSON.stringify(await read.json());
    expect(timeline).toContain("Select product");
    expect(timeline).toContain("Costs & margins");

    // A message from another page: the chip kept Costs out.
    model.toolResults.length = 0;
    const noPage = await send(author, paths.chat, conversationId, route.model, {
      label: "no-page",
      text: "Show me the Matcha financier again.",
    });
    expect(noPage.status, await noPage.clone().text()).toBe(200);
    await finished(author, conversationId);
    const refusal = model.toolResults.at(-1) ?? "";
    expect(refusal).toContain("does not carry Costs & margins");
    expect(await pageCommandCount(author)).toBe(1);

    task.meta.chatCostsCommands = {
      pageCommand: effect.command,
      shownToolResult: shownResult,
      refusedToolResult: refusal,
      modelRequests: model.requests.length,
    };
  },
);

/**
 * The scripted model: it finds the select tool, calls it once for each
 * message, and answers when the tool result arrives.
 */
async function selectProduct(
  model: Model,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body) || !Array.isArray(body.messages))
    throw new Error("Invalid model request");
  model.requests.push(JSON.stringify(body));
  const last: unknown = body.messages.at(-1);
  if (
    isRecord(last) &&
    last.role === "tool" &&
    lastToolCallName(body.messages) === "costs_view_select_product"
  ) {
    model.toolResults.push(JSON.stringify(last.content));
    return openRouterText("Done.", `j5_reply_${model.requests.length}`);
  }
  const offered = Array.isArray(body.tools)
    ? body.tools.some(
        (tool: unknown) =>
          isRecord(tool) &&
          isRecord(tool.function) &&
          tool.function.name === "costs_view_select_product",
      )
    : false;
  return offered
    ? openRouterToolCall(
        "costs_view_select_product",
        { productId: PRODUCT_ID },
        `j5_select_${model.requests.length}`,
      )
    : openRouterToolCall(
        "tool_search",
        { query: "costs_view_select_product", limit: 1 },
        `j5_discover_${model.requests.length}`,
      );
}

function send(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  message: Readonly<{
    label: string;
    text: string;
    surfaceObservation?: SurfaceObservationV2;
  }>,
): Promise<Response> {
  return post(author, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${message.label}`,
    model,
    text: message.text,
    browserContext: {
      kind: "available",
      binding: { browserInstanceId: BROWSER, conversationId },
    },
    ...(message.surfaceObservation === undefined
      ? {}
      : { surfaceObservation: message.surfaceObservation }),
  });
}

async function pendingPageCommand(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<BakerySurfaceEffectV1> {
  let found: BakerySurfaceEffectV1 | null = null;
  await expect
    .poll(
      async () => {
        found = await readPageCommand(author, chatPath, conversationId);
        return found !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (found === null) throw new Error("No page command reached the browser");
  return found;
}

async function readPageCommand(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<BakerySurfaceEffectV1 | null> {
  const response = await post(
    author,
    `${chatPath}/surface-effects?browserInstanceId=${BROWSER}&conversationId=${conversationId}`,
    null,
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.effects)) return null;
  for (const entry of body.effects) {
    if (!isRecord(entry)) continue;
    const parsed = parseBakerySurfaceEffect(entry.effect);
    if (parsed.kind === "valid" && parsed.value.command.kind === "page_command")
      return parsed.value;
  }
  return null;
}

async function pageCommandCount(author: Member): Promise<number> {
  const scope = await requireOrganisationExecutionScope(
    env,
    author.organisationId,
  );
  const row = await scope.database
    .prepare(
      "SELECT COUNT(*) AS count FROM bakery_surface_effect_delivery WHERE organisation_id = ? AND json_extract(effect_json, '$.command.kind') = 'page_command'",
    )
    .bind(author.organisationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
