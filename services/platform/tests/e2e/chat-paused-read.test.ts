import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type ConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import { revokeProductRead } from "./access-route-support";
import {
  answers,
  ask,
  currentRequest,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import {
  createConversation,
  installMemoryFixture,
  postJson,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import { installProductSource } from "./product-source-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatPausedRead?: Record<string, unknown>;
  }
}

/**
 * A person opens a chat whose run waits for a permission, unless what the
 * paused turn read has become closed to that person.
 *
 * The owner's chat holds an earlier answer. The next request pauses before its
 * first step ends. The chat and its goal open, and the owner allows the request
 * in place. In a second chat, a request reads the product draft and then asks
 * for one more read, so the paused turn holds product text that the timeline
 * does not show. The chat opens. Then the owner takes the product read away. The
 * chat and its goal close, and the refusal holds nothing of the permission.
 */
it(
  "opens a chat that waits for a permission and closes it when its paused turn holds what the reader may not read",
  { timeout: 240_000 },
  chatPausedReadJourney,
);

const PRODUCT_ID = "product_chat_paused_read_e2e";
const MERCHANT_ID = "merchant_bakery_c3_chat_paused_read";
const DESCRIPTION = "Laminated almond croissant with toasted flakes.";
const GREETING = "Which shop opens first tomorrow?";
const GREETING_ANSWER = "The Ginza shop opens first.";
const OPEN_QUESTION = `What does the croissant draft (${PRODUCT_ID}) say?`;
const OPEN_ANSWER = `The draft says: ${DESCRIPTION}`;
const CLOSED_QUESTION = `Read the croissant draft (${PRODUCT_ID}) and compare it with last week's orders.`;
const ASKED = "I asked for the permission that this request needs.";

type Recorded = { requests: number; asked: boolean };

async function chatPausedReadJourney({ task }: TestContext): Promise<void> {
  const { author, route, paths } = await installMemoryFixture();
  await installProductSource({
    organisationId: author.organisationId,
    ownerUserId: author.userId,
    merchantId: MERCHANT_ID,
    productId: PRODUCT_ID,
    description: DESCRIPTION,
  });
  const recorded: Recorded = { requests: 0, asked: false };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
  );
  const startPaused = async (
    question: string,
  ): Promise<
    Readonly<{ conversationId: ConversationId; permissionRequestId: string }>
  > => {
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);
    await ask(
      author,
      paths.chat,
      conversationId,
      route.model,
      GREETING,
      "greeting",
    );
    await expect
      .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
      .toBe("ready");
    await ask(
      author,
      paths.chat,
      conversationId,
      route.model,
      question,
      "question",
    );
    const pause = await pausedRequest(author, paths.chat, conversationId);
    return { conversationId, permissionRequestId: pause.id };
  };

  // 1. Allowed: the chat holds an earlier turn, and the person reaches Allow.
  const open = await startPaused(OPEN_QUESTION);
  const openRead = await readChat(author, paths.chat, open.conversationId);
  expect(openRead.status, JSON.stringify(openRead.body)).toBe(200);
  expect(openRead.body).toMatchObject({
    conversation: {
      work: {
        kind: "awaiting_permission",
        permission: { permissionRequestId: open.permissionRequestId },
      },
    },
  });
  // The chat shows the earlier answer. The paused step's answer stays out.
  expect(JSON.stringify(openRead.body)).toContain(GREETING_ANSWER);
  expect(JSON.stringify(openRead.body)).not.toContain(ASKED);
  const openGoal = await readGoal(author, paths.chat, open.conversationId);
  expect(openGoal.status, JSON.stringify(openGoal.body)).toBe(200);
  expect(openGoal.body).toMatchObject({ execution: "busy" });
  const allowed = await allowAsPortal(
    author.organisationId,
    author.session,
    open.permissionRequestId,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const resumed = await resumeChat(
    author,
    paths.chat,
    open.conversationId,
    open.permissionRequestId,
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await expect
    .poll(workKind.bind(null, author, open.conversationId), {
      timeout: 60_000,
    })
    .toBe("ready");
  expect(await answers(author, open.conversationId)).toEqual([
    GREETING_ANSWER,
    OPEN_ANSWER,
  ]);

  // 2. Allowed: this paused turn read the draft, and the reader may read it.
  const closing = await startPaused(CLOSED_QUESTION);
  const beforeRevoke = await readChat(
    author,
    paths.chat,
    closing.conversationId,
  );
  expect(beforeRevoke.status, JSON.stringify(beforeRevoke.body)).toBe(200);
  expect(JSON.stringify(beforeRevoke.body)).not.toContain(DESCRIPTION);

  // 3. Denied: the reader lost that read. Only the paused turn holds the text,
  // because the timeline of this chat has no product text.
  await revokeProductRead(
    author.organisationId,
    author.session,
    "organisation_role",
  );
  const refused = await readChat(author, paths.chat, closing.conversationId);
  expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  expect(refused.body).toMatchObject({
    code: "chat_history_forbidden",
    reason: "source_policy_denied",
  });
  expect(JSON.stringify(refused.body)).not.toContain(
    closing.permissionRequestId,
  );
  const refusedGoal = await readGoal(
    author,
    paths.chat,
    closing.conversationId,
  );
  expect(refusedGoal.status, JSON.stringify(refusedGoal.body)).toBe(403);

  task.meta.chatPausedRead = {
    modelRequests: recorded.requests,
    allowed: { read: openRead.status, goal: openGoal },
    denied: { read: refused, goal: refusedGoal },
    finalAnswers: await answers(author, open.conversationId),
  };
}

function readChat(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return postJson(person, `${chatPath}?conversation=${conversationId}`, null);
}

function readGoal(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return postJson(
    person,
    `${chatPath}/conversations/${conversationId}/goal`,
    null,
  );
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests += 1;
  const id = `chat_paused_read_${String(recorded.requests)}`;
  const current = currentRequest(body);
  if (current.includes(GREETING)) return reply(GREETING_ANSWER, id);
  const called = lastCalledTool(body);
  if (called === "request_permission") return reply(ASKED, id);
  if (current.includes(OPEN_QUESTION) && !recorded.asked) {
    recorded.asked = true;
    return openRouterToolCall(
      "request_permission",
      {
        capabilityIds: ["commerce.entity_plane.context"],
        entityTypeReads: ["product"],
      },
      `call_${id}`,
    );
  }
  if (called === "product_description_draft_read") {
    const output = requireLastToolOutput(body);
    expect(output).toContain(DESCRIPTION);
    if (current.includes(OPEN_QUESTION)) return reply(OPEN_ANSWER, id);
    return openRouterToolCall(
      "request_permission",
      { capabilityIds: [], entityTypeReads: ["order"] },
      `call_${id}`,
    );
  }
  // A large catalogue hides the draft tool behind tool_search.
  return offeredToolNames(body).includes("product_description_draft_read")
    ? openRouterToolCall(
        "product_description_draft_read",
        { productId: PRODUCT_ID },
        `call_${id}`,
      )
    : openRouterToolCall(
        "tool_search",
        { query: "product_description_draft_read" },
        `call_${id}`,
      );
}

function reply(text: string, id: string): Response {
  return openRouterText(JSON.stringify({ kind: "reply", text }), id);
}
