// Plan 87 J1: a chat keeps the page where it started. The first message
// carries the page on the sender's screen and sets the origin; a later
// message from another page does not move it.
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  type ConversationId,
  type SurfaceObservationV2,
} from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  createConversation,
  installMemoryFixture,
  post,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatOrigin?: Record<string, unknown>;
  }
}

const INSTANCE = {
  browserInstanceId: "browser-j1",
  surfaceSessionId: "orders-session",
  epoch: 0,
};

const ORDER_PAGE: SurfaceObservationV2 = {
  kind: "surface-observation",
  schemaVersion: 2,
  surface: "orders",
  area: "AgentCommerce",
  instance: INSTANCE,
  title: "Orders",
  path: "/portal/nuki/shop/orders/order_1042",
  record: { kind: "customer_order", id: "order_1042", label: "#1042" },
  capturedAt: 1_793_000_000_000,
  view: [],
  state: null,
  commands: [],
  sources: [],
};

const COSTS_PAGE: SurfaceObservationV2 = {
  ...ORDER_PAGE,
  surface: "costs",
  area: "BakeryOS",
  instance: { ...INSTANCE, surfaceSessionId: "costs-session" },
  title: "Costs & margins",
  path: "/portal/nuki/shop/costs",
  record: null,
  view: [
    {
      title: "Scenario inputs",
      facts: [{ label: "Shelf waste (spoil)", value: "11%" }],
      table: null,
    },
  ],
};

it(
  "keeps the page where a chat started",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, route, paths } = await installMemoryFixture();
    const requests: string[] = [];
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        recordAndReply.bind(null, requests),
      ),
    );
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);

    // The owner starts the chat on Orders with order #1042 open.
    await sendAndFinish(author, paths.chat, conversationId, route.model, {
      label: "orders",
      text: "Why is this order held?",
      surfaceObservation: ORDER_PAGE,
    });
    const started = await readChat(author, paths.chat, conversationId);
    const origin = {
      area: "AgentCommerce",
      page: "orders",
      title: "Orders",
      record: { kind: "customer_order", id: "order_1042", label: "#1042" },
      startedAt: expect.any(Number),
    };
    expect(started.conversation.origin).toEqual(origin);
    expect(listedOrigin(started, conversationId)).toEqual(origin);
    const firstInput = latestUserInput(requests);
    expect(firstInput).toContain("This chat started on Orders, #1042");
    expect(firstInput).toContain(
      "The current request carries Orders, #1042 from the operator's screen",
    );
    // Orders registers no view: the model learns that the page sent only its
    // name, so it does not read an empty list as a page with no orders.
    expect(firstInput).toContain(
      "That page sends only its name, address and open record, not what it shows",
    );
    expect(firstInput).not.toContain('"view":[]');

    // The owner moves to Costs & margins and sends that page.
    await sendAndFinish(author, paths.chat, conversationId, route.model, {
      label: "costs",
      text: "What spoil rate is on screen now?",
      surfaceObservation: COSTS_PAGE,
    });
    const moved = await readChat(author, paths.chat, conversationId);
    expect(moved.conversation.origin).toEqual(started.conversation.origin);
    const costsInput = latestUserInput(requests);
    expect(costsInput).toContain("This chat started on Orders, #1042");
    expect(costsInput).toContain(
      "The current request carries Costs & margins from the operator's screen",
    );
    expect(costsInput).toContain("Shelf waste (spoil)");
    // The message shows the page that went with it, and not its view.
    const marks = userScreenParts(moved);
    expect(marks).toEqual([
      { kind: "screen", area: "AgentCommerce", title: "Orders", record: "#1042" },
      { kind: "screen", area: "BakeryOS", title: "Costs & margins", record: null },
    ]);
    expect(JSON.stringify(moved.conversation)).not.toContain(
      "Shelf waste (spoil)",
    );

    // A message with no page says so, and the origin stays.
    await sendAndFinish(author, paths.chat, conversationId, route.model, {
      label: "plain",
      text: "Thanks.",
    });
    const plainInput = latestUserInput(requests);
    expect(plainInput).toContain("This chat started on Orders, #1042");
    expect(plainInput).toContain(
      "The current request carries no page from the operator's screen",
    );
    expect(plainInput).not.toContain("Shelf waste (spoil)");

    task.meta.chatOrigin = {
      origin: started.conversation.origin,
      listedOrigin: listedOrigin(started, conversationId),
      originAfterCosts: moved.conversation.origin,
      messageMarks: marks,
      modelInputs: {
        firstOnOrders: firstInput,
        fromCosts: costsInput,
        withNoPage: plainInput,
      },
    };
  },
);

type ChatRead = Readonly<{
  conversation: Record<string, unknown>;
  conversations: readonly unknown[];
}>;

async function readChat(
  member: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<ChatRead> {
  const response = await post(
    member,
    `${chatPath}?conversation=${conversationId}`,
    null,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !isRecord(body.conversation) ||
    !Array.isArray(body.conversations)
  )
    throw new Error("The chat read has no conversation");
  return { conversation: body.conversation, conversations: body.conversations };
}

function listedOrigin(read: ChatRead, conversationId: ConversationId): unknown {
  const row = read.conversations.find(
    (entry) => isRecord(entry) && entry.id === conversationId,
  );
  return isRecord(row) ? row.origin : undefined;
}

function userScreenParts(read: ChatRead): readonly unknown[] {
  const timeline = Array.isArray(read.conversation.timeline)
    ? read.conversation.timeline
    : [];
  return timeline.flatMap((event: unknown) =>
    isRecord(event) && event.kind === "user" && Array.isArray(event.parts)
      ? event.parts.filter(
          (part: unknown) => isRecord(part) && part.kind === "screen",
        )
      : [],
  );
}

async function sendAndFinish(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  message: Readonly<{
    label: string;
    text: string;
    surfaceObservation?: SurfaceObservationV2;
  }>,
): Promise<void> {
  const response = await post(author, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${message.label}`,
    model,
    text: message.text,
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
    ...(message.surfaceObservation === undefined
      ? {}
      : { surfaceObservation: message.surfaceObservation }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
}

async function recordAndReply(
  requests: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(JSON.stringify(body));
  return openRouterText("Noted.", `chat_origin_${String(requests.length)}`);
}

/** The newest user message of the newest model request. */
function latestUserInput(requests: readonly string[]): string {
  const latest = requests.at(-1);
  if (latest === undefined) throw new Error("The model received no request");
  const body: unknown = JSON.parse(latest);
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (isRecord(message) && message.role === "user")
      return JSON.stringify(message.content);
  }
  throw new Error("The model request has no user message");
}
