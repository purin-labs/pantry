// The owner asks the Portal chat agent if the orders on the Orders page are
// fulfilled. The agent reads the orders with commerce_entity_context and names
// fields that do not include `lifecycle`, as a real model did in production
// (Plan 87, 7 November 2026). The read still gives each order the lifecycle
// state that the Orders page shows. An administrator who holds no order read
// gets no order and no state.
import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  parseOrderQueueEntries,
  type OrderQueueAction,
  type OrderQueueEntry,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { placeCafeOrder, publishCafeMenu } from "./cafe-order-support";
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
  postJson,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import { providerClient } from "./pi-sdk-effect-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentOrderLifecycle?: Record<string, unknown>;
  }
}

const MERCHANT_ID = "merchant_chat_order_lifecycle";
const QUESTION =
  "How many customer orders are on my screen, and are they all fulfilled?";
const REFUSED_ANSWER = "I asked for permission to read the orders.";

type OrderState = Readonly<{ id: string; lifecycle: string | null }>;

type Recorded = {
  /** Who asks the current question. */
  person: "owner" | "admin";
  /** Each commerce_entity_context output that the model got, by person. */
  readonly reads: { person: "owner" | "admin"; output: string }[];
  /** Each model step: the tool whose output it got, by person. */
  readonly steps: string[];
};

/** The page of orders, as the Orders page asks for it. */
const ORDER_PAGE = {
  kind: "entity_type_page",
  entityTypeId: { origin: "system", typeId: "order" },
  filter: { kind: "all" },
  sorts: [],
  pagination: { limit: 50, cursor: null },
  traversal: { maxDepth: 0, resultLimit: 50 },
} as const;

it(
  "gives the agent each order's lifecycle state that the Orders page shows, and none to an administrator without the order read",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, reviewer, route, paths } = await installMemoryFixture();
    await connectCommerceFixture(
      author.organisationId,
      author.userId,
      MERCHANT_ID,
    );
    const demo = await providerClient().provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: author.organisationId,
      merchantId: MERCHANT_ID,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    });
    if (!demo.ok) throw new Error(JSON.stringify(demo.error));
    await publishCafeMenu(MERCHANT_ID);
    // One order is handed over and fulfilled; the other waits in the queue.
    const handed = await placeCafeOrder(MERCHANT_ID, ["item_cookie"]);
    const waiting = await placeCafeOrder(MERCHANT_ID);
    await handOver(author, paths.organisation, handed);

    // What the owner's Orders page shows.
    const page = await portalOrders(author, paths.organisation);
    expect(sortById(page).map((order) => order.id)).toEqual(
      [handed, waiting].sort((left, right) => left.localeCompare(right)),
    );
    expect(page.find((order) => order.id === handed)?.lifecycle).toBe(
      "fulfilled",
    );
    expect(page.find((order) => order.id === waiting)?.lifecycle).not.toBe(
      "fulfilled",
    );

    const recorded: Recorded = { person: "owner", reads: [], steps: [] };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyAboutOrders.bind(null, recorded),
      ),
    );

    // The owner allows the commerce context read and the order read once.
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);
    await ask(author, paths.chat, conversationId, route.model, QUESTION, "q");
    let previous: string | null = null;
    for (let allowed = 0; allowed < 3; allowed += 1) {
      const settled = await settledWork(author, conversationId);
      if (settled === "ready") break;
      const pause = await pausedRequest(
        author,
        paths.chat,
        conversationId,
        previous,
      );
      previous = pause.id;
      const allow = await allowAsPortal(
        author.organisationId,
        author.session,
        pause.id,
      );
      expect(allow.status, await allow.clone().text()).toBe(200);
      const resumed = await resumeChat(
        author,
        paths.chat,
        conversationId,
        pause.id,
      );
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    }
    expect(await settledWork(author, conversationId)).toBe("ready");

    // The model input holds every order of the page with the page's state.
    const ownerRead = recorded.reads.filter((read) => read.person === "owner");
    expect(ownerRead.length, recorded.steps.join(" ")).toBeGreaterThan(0);
    const read = ownerRead.at(-1)?.output ?? "";
    const agentOrders = modelOrders(read);
    expect(sortById(agentOrders)).toEqual(sortById(page));
    const fulfilled = page.filter((order) => order.lifecycle === "fulfilled");
    expect(await answers(author, conversationId)).toEqual([
      orderAnswer(agentOrders),
    ]);
    expect(orderAnswer(agentOrders)).toBe(
      `${String(page.length)} customer orders; ${String(fulfilled.length)} fulfilled.`,
    );

    // An administrator without the order read asks the same. The owner allows
    // the commerce context read for them, and the order read stays refused:
    // the chat pauses on it, and the model gets no order and no state.
    recorded.person = "admin";
    const adminChat = newConversationId();
    await createConversation(reviewer, adminChat, route);
    await ask(reviewer, paths.chat, adminChat, route.model, QUESTION, "admin");
    const context = await pausedRequest(reviewer, paths.chat, adminChat);
    expect(JSON.stringify(context.permission)).toContain(
      "commerce.entity_plane.context",
    );
    const contextAllow = await allowAsPortal(
      author.organisationId,
      author.session,
      context.id,
    );
    expect(contextAllow.status, await contextAllow.clone().text()).toBe(200);
    const adminResumed = await resumeChat(
      reviewer,
      paths.chat,
      adminChat,
      context.id,
    );
    expect(adminResumed.status, JSON.stringify(adminResumed.body)).toBe(200);
    const orderPause = await pausedRequest(
      reviewer,
      paths.chat,
      adminChat,
      context.id,
    );
    expect(JSON.stringify(orderPause.permission)).toContain(
      "commerce.entity.read:order",
    );
    const adminReads = recorded.reads.filter(
      (entry) => entry.person === "admin",
    );
    expect(adminReads.length, recorded.steps.join(" ")).toBeGreaterThan(0);
    for (const entry of adminReads) {
      expect(entry.output).not.toContain('"ok":true');
      expect(entry.output).not.toContain("fulfilled");
      for (const order of page) expect(entry.output).not.toContain(order.id);
    }
    expect(await answers(reviewer, adminChat)).not.toContain(
      orderAnswer(agentOrders),
    );

    task.meta.chatAgentOrderLifecycle = {
      page,
      agentOrders,
      answers: await answers(author, conversationId),
      adminReads: adminReads.map((entry) => entry.output),
      adminPause: orderPause.permission,
    };
  },
);

/** Staff take every pickup of one order from the queue to the hand-over. */
async function handOver(
  owner: Member,
  organisationPath: string,
  orderId: string,
): Promise<void> {
  const queuePath = `${organisationPath}/commerce/order-queue`;
  let entries: readonly OrderQueueEntry[] = [];
  await expect
    .poll(
      async () => {
        entries = (await queue(owner, queuePath)).filter(
          (entry) => entry.orderId === orderId,
        );
        return entries.length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  for (const entry of entries) {
    const actions: readonly OrderQueueAction[] =
      entry.preparation === "not_needed" ? ["ready"] : ["start", "ready"];
    for (const action of [...actions, "hand_over" as const]) {
      const moved = await advance(
        owner,
        queuePath,
        entry.fulfillmentId,
        action,
      );
      expect(moved.status, `${action}: ${await moved.clone().text()}`).toBe(
        200,
      );
    }
  }
}

async function queue(
  owner: Member,
  queuePath: string,
): Promise<readonly OrderQueueEntry[]> {
  const response = await exports.default.fetch(
    `https://localhost${queuePath}`,
    {
      headers: commerceHeaders(owner.session),
    },
  );
  const body: unknown = await response.json();
  const entries = parseOrderQueueEntries(isRecord(body) ? body.entries : null);
  if (entries === null) throw new Error(`No queue: ${JSON.stringify(body)}`);
  return entries;
}

function advance(
  owner: Member,
  queuePath: string,
  fulfillmentId: string,
  action: OrderQueueAction,
): Promise<Response> {
  const headers = commerceHeaders(owner.session);
  headers.set("idempotency-key", crypto.randomUUID());
  headers.set("x-pantry-configuration-version", "1");
  return exports.default.fetch(
    `https://localhost${queuePath}/${encodeURIComponent(fulfillmentId)}/advance`,
    { method: "POST", headers, body: JSON.stringify({ action }) },
  );
}

async function settledWork(
  person: Member,
  conversationId: ReturnType<typeof newConversationId>,
): Promise<string> {
  await expect
    .poll(workKind.bind(null, person, conversationId), { timeout: 60_000 })
    .toMatch(/^(ready|awaiting_permission)$/u);
  return String(await workKind(person, conversationId));
}

async function portalOrders(
  owner: Member,
  organisationPath: string,
): Promise<OrderState[]> {
  const read = await postJson(owner, `${organisationPath}/commerce/graph`, {
    query: ORDER_PAGE,
  });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  if (!isRecord(read.body)) throw new Error("No commerce graph result");
  const result = isRecord(read.body.result) ? read.body.result : read.body;
  return ordersOf(result);
}

function ordersOf(result: Record<string, unknown>): OrderState[] {
  const entities = Array.isArray(result.entities) ? result.entities : [];
  return entities.flatMap((entity: unknown) => {
    if (!isRecord(entity) || !isRecord(entity.reference)) return [];
    if (entity.reference.typeId !== "order") return [];
    const attributes = Array.isArray(entity.attributes)
      ? entity.attributes
      : [];
    const lifecycle = attributes.find(
      (attribute: unknown) =>
        isRecord(attribute) && attribute.attributeId === "lifecycle",
    );
    const value =
      isRecord(lifecycle) &&
      isRecord(lifecycle.value) &&
      typeof lifecycle.value.value === "string"
        ? lifecycle.value.value
        : null;
    return [{ id: String(entity.reference.entityId), lifecycle: value }];
  });
}

/** The orders in the read that the model got as its tool result. */
function modelOrders(output: string): OrderState[] {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result))
    throw new Error(`The order read failed: ${output}`);
  return ordersOf(parsed.result);
}

function sortById(orders: readonly OrderState[]): OrderState[] {
  return [...orders].sort((left, right) => left.id.localeCompare(right.id));
}

function orderAnswer(orders: readonly OrderState[]): string {
  const fulfilled = orders.filter((order) => order.lifecycle === "fulfilled");
  return `${String(orders.length)} customer orders; ${String(fulfilled.length)} fulfilled.`;
}

/** The text of the latest tool message that the model got. */
function lastToolText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (!isRecord(message) || message.role !== "tool") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content))
      return message.content
        .map((part: unknown) =>
          isRecord(part) && typeof part.text === "string" ? part.text : "",
        )
        .join("");
  }
  throw new Error("No tool message");
}

async function replyAboutOrders(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const id = `order_lifecycle_${String(recorded.reads.length)}_${String(Date.now())}`;
  const called = lastCalledTool(body);
  recorded.steps.push(`${recorded.person}:${called ?? "start"}`);
  // The model names the fields that it thinks of; `lifecycle` is not one.
  const read = (): Response =>
    openRouterToolCall(
      "commerce_entity_context",
      {
        request: {
          selection: {
            kind: "selector",
            selector: {
              selectorId: "type:order",
              revision: 1,
              query: ORDER_PAGE,
            },
          },
          traversal: { maxDepth: 0, resultLimit: 50 },
          allowedSensitivity: "internal",
          allowedAttributeIds: ["fulfillment_status"],
          freshnessRequirement: "current_only",
        },
      },
      `call_${id}`,
    );
  const search = (): Response =>
    openRouterToolCall(
      "tool_search",
      { query: "commerce_entity_context", limit: 1 },
      `call_${id}`,
    );
  const offered = offeredToolNames(body).includes("commerce_entity_context");
  // Without the commerce context read, the agent asks for it in the chat.
  const askForContext = (): Response =>
    openRouterToolCall(
      "request_permission",
      { capabilityIds: ["commerce.entity_plane.context"], entityTypeReads: [] },
      `call_${id}`,
    );
  if (called === null) return offered ? read() : search();
  if (called === "tool_search" || called === "request_permission") {
    if (offered) return read();
    return called === "tool_search" ? askForContext() : search();
  }
  if (called !== "commerce_entity_context")
    throw new Error(`Unexpected tool ${called}`);
  const output = lastToolText(body);
  recorded.reads.push({ person: recorded.person, output });
  if (recorded.person === "admin") return openRouterText(REFUSED_ANSWER, id);
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || parsed.ok !== true)
    // A refused read pauses the chat on its permission request.
    return openRouterText(REFUSED_ANSWER, id);
  return openRouterText(orderAnswer(modelOrders(output)), id);
}
