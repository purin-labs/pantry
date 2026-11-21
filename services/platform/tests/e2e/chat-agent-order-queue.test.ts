// The Portal chat agent works the shop's order queue and "sold out today" as
// staff do on the page (Plan 81, Plan 40B phase 3), and reads the shop's
// payments as the Payments page shows them. A real shop and a real paid order
// on the production Worker and Commerce; only the model answers from a
// script. An order moves through the queue, an item goes sold out and checkout
// refuses it, a declined card and two paid orders show in the payments read,
// and refused requests change nothing.
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  parseOrderQueueEntries,
  parsePaymentsDay,
  parseSoldOutItems,
  type OrderQueueEntry,
  type SoldOutItem,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import {
  declineCafeOrder,
  placeCafeOrder,
  publishCafeMenu,
  required,
} from "./cafe-order-support";
import {
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { connectCommerceFixture } from "./commerce-support";
import {
  installMemoryFixture,
  post,
  postJson,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal, readRequest } from "./permission-request-support";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { providerClient } from "./pi-sdk-effect-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";
import {
  chatDirect,
  finished,
  messageWord,
  startChat,
} from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentOrderQueue?: Record<string, unknown>;
  }
}

const MERCHANT_ID = "merchant_chat_order_queue";
const BUYER_EMAIL = "buyer-private@example.test";
const TIME_ZONE = "Asia/Tokyo";

/** What the model does for one chat message, found by a word in the message. */
type Script = Readonly<{
  /** The tool that the agent calls. */
  tool: string;
  args: () => Record<string, unknown>;
  /** What the agent asks for when the tool is not in its catalogue. */
  ask?: Readonly<{
    capabilityIds: readonly string[];
    entityTypeReads: readonly string[];
  }>;
}>;

type Journey = {
  /** The outputs of each message's tool, by the message's word. */
  readonly outputs: Record<string, string[]>;
  modelRequests: number;
  fulfillmentId: string;
  variantId: string;
};

function scripts(journey: Journey): Readonly<Record<string, Script>> {
  const advance = (action: string): (() => Record<string, unknown>) => {
    return () => ({ fulfillmentId: journey.fulfillmentId, action });
  };
  const mark = (
    variantId: () => string,
    soldOut: boolean,
    timeZone: string | null,
  ): (() => Record<string, unknown>) => {
    return () => ({ variantId: variantId(), soldOut, timeZone });
  };
  const item = (): string => journey.variantId;
  return {
    READQUEUE: { tool: "order_queue_read", args: () => ({}) },
    STARTORDER: {
      tool: "order_queue_advance",
      args: advance("start"),
      ask: {
        capabilityIds: ["commerce.order_queue.advance"],
        entityTypeReads: ["order"],
      },
    },
    TOOEARLY: { tool: "order_queue_advance", args: advance("hand_over") },
    MAKEREADY: { tool: "order_queue_advance", args: advance("ready") },
    PASSORDER: { tool: "order_queue_advance", args: advance("hand_over") },
    PASSAGAIN: { tool: "order_queue_advance", args: advance("hand_over") },
    READSOLDOUT: { tool: "sold_out_read", args: () => ({}) },
    MARKSOLDOUT: {
      tool: "sold_out_mark",
      args: mark(item, true, TIME_ZONE),
      ask: {
        capabilityIds: ["commerce.sold_out.mark"],
        entityTypeReads: ["product"],
      },
    },
    NOZONE: { tool: "sold_out_mark", args: mark(item, true, null) },
    OFFMENU: {
      tool: "sold_out_mark",
      args: mark(() => "variant_nothing", true, TIME_ZONE),
    },
    CLEARSOLDOUT: { tool: "sold_out_mark", args: mark(item, false, null) },
    READPAYMENTS: {
      tool: "payments_read",
      args: () => ({
        start: new Date(Date.now() - 3_600_000).toISOString(),
        end: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    },
    BADWINDOW: {
      tool: "payments_read",
      args: () => ({
        start: new Date(Date.now() + 3_600_000).toISOString(),
        end: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    },
  };
}

it(
  "lets the Portal chat agent move an order through the queue, mark an item sold out and read the payments with the person's checks and prompts",
  { timeout: 480_000 },
  async ({ task }: TestContext): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, viewer, paths } = fixture;
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
    const orderId = await placeCafeOrder(MERCHANT_ID);
    const journey: Journey = {
      outputs: {},
      modelRequests: 0,
      fulfillmentId: "",
      variantId: "",
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey),
      ),
    );
    const evidence: Record<string, unknown> = {};

    /** The person's own page reads. They prove the outcome, not the tool. */
    const queue = async (): Promise<readonly OrderQueueEntry[]> => {
      const read = await postJson(
        author,
        `${paths.organisation}/commerce/order-queue`,
        null,
      );
      const parsed = parseOrderQueueEntries(
        isRecord(read.body) ? read.body.entries : null,
      );
      if (parsed === null) throw new Error(JSON.stringify(read.body));
      return parsed;
    };
    const menu = async (): Promise<readonly SoldOutItem[]> => {
      const read = await postJson(
        author,
        `${paths.organisation}/commerce/sold-out`,
        null,
      );
      const parsed = parseSoldOutItems(
        isRecord(read.body) ? read.body.items : null,
      );
      if (parsed === null) throw new Error(JSON.stringify(read.body));
      return parsed;
    };
    const entry = async (): Promise<OrderQueueEntry | undefined> =>
      (await queue()).find(
        (candidate) => candidate.fulfillmentId === journey.fulfillmentId,
      );
    const lastOutput = (word: string): string => {
      const output = journey.outputs[word]?.at(-1);
      if (output === undefined) throw new Error(`No output for ${word}`);
      return output;
    };

    // The owner first allows the commerce context read.
    await chatThrough(fixture, author, "GETREADY", {});

    // 1. A refused queue read asks in the chat, and a resume before the allow
    //    costs no model step. No text sends the owner to a settings page.
    const queueRead = await chatThrough(fixture, author, "READQUEUE", {
      action: "Read customer orders",
      resumeEarly: journey,
    });
    evidence.queueReadRequest = queueRead.request;
    const read = lastOutput("READQUEUE");
    expect(read).not.toContain(BUYER_EMAIL);
    const taro = (await queue()).find((candidate) =>
      candidate.lines.some((line) => line.title === "Taro Milk Tea"),
    );
    if (taro === undefined)
      throw new Error("The paid order is not in the queue");
    expect(read).toContain(taro.code);
    expect(taro).toMatchObject({ stage: "preparing", orderId });
    journey.fulfillmentId = taro.fulfillmentId;

    // 2. The agent has no move. It asks once, and the owner allows it.
    await chatThrough(fixture, author, "STARTORDER", {
      action: "Move orders through the shop's order queue",
    });
    expect(lastOutput("STARTORDER")).toContain("receiptId");
    expect(await entry()).toMatchObject({
      stage: "preparing",
      preparation: "preparing",
    });

    // 3. An early hand-over is refused, as on the page, and the order stays.
    await chatDirect(fixture, author, "TOOEARLY");
    expect(lastOutput("TOOEARLY")).toContain("must be ready");
    expect(await entry()).toMatchObject({ stage: "preparing" });

    // 4. Ready, and then the hand-over.
    await chatDirect(fixture, author, "MAKEREADY");
    expect(await entry()).toMatchObject({
      stage: "ready",
      preparation: "completed",
    });
    await chatDirect(fixture, author, "PASSORDER");
    expect(lastOutput("PASSORDER")).toContain("receiptId");
    expect(await entry()).toBeUndefined();
    const snapshot = await required(
      providerClient().readStockSnapshot(MERCHANT_ID),
    );
    const order = snapshot.commerce.resources.orders.find(
      (candidate) => candidate.id === orderId,
    );
    expect(order?.lifecycle.state).toBe("fulfilled");
    evidence.orderAfterHandOver = order?.lifecycle.state;

    // 5. A second hand-over from another chat finds nothing to move.
    await chatDirect(fixture, author, "PASSAGAIN");
    expect(lastOutput("PASSAGAIN")).toContain("left the queue");

    // Each move has one receipt of the person's route.
    evidence.receipts = await moveReceipts(fixture, journey.fulfillmentId);
    expect(evidence.receipts).toEqual([
      { operation: "order_queue.hand_over", n: 1 },
      { operation: "order_queue.ready", n: 1 },
      { operation: "order_queue.start", n: 1 },
    ]);

    // 6. Sold out today: the read asks for product records.
    const soldOutRead = await chatThrough(fixture, author, "READSOLDOUT", {
      action: "Read product records",
    });
    evidence.soldOutReadRequest = soldOutRead.request;
    const milkTea = (await menu()).find(
      (item) => item.title === "Taro Milk Tea",
    );
    if (milkTea === undefined) throw new Error("No menu item");
    expect(lastOutput("READSOLDOUT")).toContain(milkTea.variantId);
    journey.variantId = milkTea.variantId;

    // 7. The agent asks for the mark. The page shows it, checkout refuses the
    //    item, and the stock count does not move.
    const stockBefore = await required(
      providerClient().readStockSnapshot(MERCHANT_ID),
    );
    await chatThrough(fixture, author, "MARKSOLDOUT", {
      action: "Mark menu items sold out today",
    });
    const marked = (await menu()).find(
      (item) => item.variantId === milkTea.variantId,
    );
    expect(Date.parse(marked?.soldOutUntil ?? "")).toBeGreaterThan(Date.now());
    await pastCatalogSnapshot();
    const refused = await placeCafeOrder(MERCHANT_ID).then(
      () => "paid",
      (error: unknown) => String(error),
    );
    expect(refused).not.toBe("paid");
    const stockAfter = await required(
      providerClient().readStockSnapshot(MERCHANT_ID),
    );
    expect(stockAfter.commerce.resources.inventoryPositions).toEqual(
      stockBefore.commerce.resources.inventoryPositions,
    );

    // 8. No time zone and an item off the menu are refused in words.
    await chatDirect(fixture, author, "NOZONE");
    expect(lastOutput("NOZONE")).toContain("IANA time zone");
    await chatDirect(fixture, author, "OFFMENU");
    expect(lastOutput("OFFMENU")).toContain("not on the published");

    // 9. The agent clears the mark, and a customer pays again.
    await chatDirect(fixture, author, "CLEARSOLDOUT");
    expect(
      (await menu()).find((item) => item.variantId === milkTea.variantId)
        ?.soldOutUntil,
    ).toBeNull();
    await pastCatalogSnapshot();
    const secondOrderId = await placeCafeOrder(MERCHANT_ID);
    expect((await queue()).map((candidate) => candidate.orderId)).toContain(
      secondOrderId,
    );

    // 10. Payments. A buyer's card is declined, and two other buyers paid. The
    //     agent reads the same payments as the page, with the counts, and
    //     names no buyer. A window with its end first is refused in words.
    const declinedAttempt = await declineCafeOrder(MERCHANT_ID);
    const readPaymentsPage = async (): Promise<
      ReturnType<typeof parsePaymentsDay>
    > => {
      const now = Date.now();
      const read = await postJson(
        author,
        `${paths.organisation}/commerce/payments?from=${String(now - 3_600_000)}&to=${String(now + 3_600_000)}`,
        null,
      );
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      return parsePaymentsDay(read.body);
    };
    const page = await readPaymentsPage();
    expect(page.steps.map((step) => step.state).sort()).toEqual([
      "declined",
      "paid",
      "paid",
    ]);
    await chatDirect(fixture, author, "READPAYMENTS");
    const paymentsOutput = lastOutput("READPAYMENTS");
    expect(paymentsOutput).not.toContain(BUYER_EMAIL);
    expect(paymentsOutput).toContain(declinedAttempt);
    expect(paymentsOutput).toContain("card_declined");
    for (const step of page.steps)
      expect(paymentsOutput).toContain(step.paymentAttemptId);
    for (const step of page.steps)
      if (step.orderCode !== null)
        expect(paymentsOutput).toContain(step.orderCode);
    // The tool output is JSON inside JSON, so a quote may carry escapes.
    expect(paymentsOutput.replaceAll("\\", "")).toContain(
      '"runsByOutcome":{"paid_first_try":2,"recovered_after_decline":0,"not_recovered":1}',
    );
    evidence.paymentsRead = { steps: page.steps.length };
    await chatDirect(fixture, author, "BADWINDOW");
    expect(lastOutput("BADWINDOW")).toContain("ISO 8601");

    // 11. A Portal chat is for an owner or an admin. A viewer's message does
    //     not reach the agent, and the page refuses the queue.
    const viewerPage = await postJson(
      viewer,
      `${paths.organisation}/commerce/order-queue`,
      null,
    );
    expect(viewerPage.body).toMatchObject({
      error: "organisation_role_insufficient",
    });
    const viewerPayments = await postJson(
      viewer,
      `${paths.organisation}/commerce/payments?from=0&to=1`,
      null,
    );
    expect(viewerPayments.body).toMatchObject({
      error: "organisation_role_insufficient",
    });
    const spentBeforeViewer = journey.modelRequests;
    const viewerChat = await post(viewer, paths.chat, {
      kind: "message",
      conversationId: newConversationId(),
      requestId: "request_viewer_queue",
      model: fixture.route.model,
      text: "READQUEUE now.",
      browserContext: { kind: "unavailable" },
    });
    expect(await viewerChat.json()).toMatchObject({
      error: "organisation_role_insufficient",
    });
    expect(journey.modelRequests).toBe(spentBeforeViewer);

    task.meta.chatAgentOrderQueue = {
      ...evidence,
      viewerPage,
    };
  },
);

/** Commerce's catalog snapshot lives 2 s. */
function pastCatalogSnapshot(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_500));
}

/**
 * One chat message that pauses on a request. The owner allows it in place, and
 * the same step runs again. With `resumeEarly`, a resume before the allow is
 * refused first, and it costs no model step.
 */
async function chatThrough(
  fixture: MemoryFixture,
  person: Member,
  word: string,
  options: Readonly<{ action?: string; resumeEarly?: Journey }>,
): Promise<Readonly<{ request: Record<string, unknown> }>> {
  const conversationId = await startChat(fixture, person, word);
  const pause = await pausedRequest(person, fixture.paths.chat, conversationId);
  if (options.action !== undefined)
    expect(pause.permission).toMatchObject({ action: options.action });
  if (options.resumeEarly !== undefined) {
    const spent = options.resumeEarly.modelRequests;
    const early = await resumeChat(
      person,
      fixture.paths.chat,
      conversationId,
      pause.id,
    );
    expect(early.status).toBe(409);
    expect(options.resumeEarly.modelRequests).toBe(spent);
  }
  const allowed = await allowAsPortal(
    person.organisationId,
    person.session,
    pause.id,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const resumed = await resumeChat(
    person,
    fixture.paths.chat,
    conversationId,
    pause.id,
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await finished(person, conversationId);
  return {
    request: await readRequest(person.organisationId, person.session, pause.id),
  };
}

async function moveReceipts(
  fixture: MemoryFixture,
  fulfillmentId: string,
): Promise<unknown> {
  const scope = await requireOrganisationExecutionScope(
    env,
    fixture.organisationId,
  );
  const rows = await scope.database
    .prepare(
      "SELECT operation, COUNT(*) AS n FROM control_mutation_receipt WHERE organisation_scope = ? AND route = ? AND substr(idempotency_key, 1, 6) = 'agent_' GROUP BY operation ORDER BY operation",
    )
    .bind(
      fixture.organisationId,
      `${fixture.paths.organisation}/commerce/order-queue/${fulfillmentId}/advance`,
    )
    .all();
  return rows.results;
}

async function replyToModel(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  journey.modelRequests += 1;
  const id = `queue_${String(journey.modelRequests)}`;
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  const called = lastCalledTool(body);
  const all = scripts(journey);
  const word = messageWord(body, ["GETREADY", ...Object.keys(all)]);
  if (word === "GETREADY")
    return called === null
      ? openRouterToolCall(
          "request_permission",
          {
            capabilityIds: ["commerce.entity_plane.context"],
            entityTypeReads: [],
          },
          `call_${id}`,
        )
      : reply("Ready.");
  const script = all[word];
  if (script === undefined) throw new Error(`No script for ${word}`);
  const callTool = (): Response =>
    openRouterToolCall(script.tool, script.args(), `call_${id}`);
  if (called === null)
    return offeredToolNames(body).includes(script.tool)
      ? callTool()
      : openRouterToolCall(
          "tool_search",
          { query: script.tool, limit: 1 },
          `call_${id}`,
        );
  const output = requireLastToolOutput(body);
  switch (called) {
    case "tool_search":
      if (offeredToolNames(body).includes(script.tool)) return callTool();
      if (script.ask === undefined)
        throw new Error(`${word} found no ${script.tool}: ${output}`);
      return openRouterToolCall("request_permission", script.ask, `call_${id}`);
    case "request_permission":
      expect(output).toContain("Allow prompt");
      return reply("I asked for permission.");
    case script.tool: {
      if (output.includes("Allow prompt")) {
        expect(output).not.toContain("access controls");
        return reply("I asked for permission.");
      }
      journey.outputs[word] = [...(journey.outputs[word] ?? []), output];
      return reply(`Finished ${word}.`);
    }
    default:
      throw new Error(`Unexpected tool ${called} for ${word}`);
  }
}
