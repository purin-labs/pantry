import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import {
  answers,
  ask,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import {
  createConversation,
  installMemoryFixture,
  storedConversation,
  workKind,
} from "./memory-support";
import { network } from "./network";
import { installProductSource } from "./product-source-support";
import {
  allowAsPortal,
  readPendingRequests,
  readRequest,
} from "./permission-request-support";
import { revokeProductRead } from "./access-route-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentPermissionRequest?: Record<string, unknown>;
  }
}

/**
 * An agent in a Portal chat asks for what it lacks in one prompt, and the
 * person allows it in place. The waiting request is in the owner's pending
 * list, not in a viewer's, and leaves the list once it is allowed.
 *
 * The owner asks the Portal chat what a product description draft says. The
 * commerce context read is turned off, and nobody can read product records.
 * The agent asks for the context read and the product read in one call; the
 * chat pauses on one request instead of answering, and its answer is not
 * shown. A resume before anybody allows it is refused and costs no model
 * step. The owner allows it in place, and the step runs again, reads the
 * draft and answers. Then the owner takes the product read away again and
 * asks in a new chat, because the first chat now holds product text that
 * the owner cannot read: the draft read is denied, Pantry asks for the read
 * by itself, and after the owner allows it the step answers again.
 */
it(
  "pauses a Portal chat on one permission request for everything the agent lacks and continues after the owner allows it",
  { timeout: 240_000 },
  chatAgentPermissionJourney,
);

const PRODUCT_ID = "product_chat_permission_e2e";
const MERCHANT_ID = "merchant_bakery_c3_chat_permission";
const DESCRIPTION = "Freshly baked croissant with cultured butter.";
const QUESTION = `What does the description draft of the croissant (${PRODUCT_ID}) say?`;
const QUESTION_AGAIN = `Read the croissant draft (${PRODUCT_ID}) once more, please.`;
const ASKED = "I asked for permission to read the draft.";
const ANSWER = `The draft says: ${DESCRIPTION}`;

type Recorded = {
  readonly requests: Record<string, unknown>[];
  /** The tools offered at the start of each turn. */
  readonly turns: string[][];
  deniedReads: number;
};

async function chatAgentPermissionJourney({
  task,
}: TestContext): Promise<void> {
  const { author, viewer, route, paths } = await installMemoryFixture();
  await installProductSource({
    organisationId: author.organisationId,
    ownerUserId: author.userId,
    merchantId: MERCHANT_ID,
    productId: PRODUCT_ID,
    description: DESCRIPTION,
  });
  const recorded: Recorded = { requests: [], turns: [], deniedReads: 0 };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
  );
  const conversationId = newConversationId();
  await createConversation(author, conversationId, route);
  await ask(author, paths.chat, conversationId, route.model, QUESTION, "first");

  // 1. The agent asks for both reads in one call; the chat pauses once.
  const pause = await pausedRequest(author, paths.chat, conversationId);
  expect(recorded.turns).toHaveLength(1);
  const askingRequests = recorded.requests.length;
  expect(pause.permission).toMatchObject({
    action: "Read product records and read scoped commerce context",
    items: [
      {
        kind: "agent_request",
        itemId: "commerce.entity.read:product:requester",
      },
      { kind: "agent_request", itemId: "commerce.entity_plane.context" },
    ],
  });
  const paused = await storedConversation(author, conversationId);
  expect(JSON.stringify(paused?.conversation.timeline)).not.toContain(ASKED);
  expect(
    await readRequest(author.organisationId, author.session, pause.id),
  ).toMatchObject({
    status: "pending",
    origin: "portal_chat",
    threadUrl: null,
    requesterRole: "owner",
    mayDecide: true,
    items: [
      {
        capabilityId: "commerce.entity.read",
        granted: false,
        grant: {
          subjectLabel: "Owners",
          target: {
            kind: "commerce_entity_type",
            entityTypeId: { origin: "system", typeId: "product" },
          },
        },
      },
      {
        capabilityId: "commerce.entity_plane.context",
        granted: false,
        grant: { subjectLabel: "Owners", target: { kind: "platform" } },
      },
    ],
  });

  // The owner finds the request in the pending list; a viewer, who did not
  // ask and cannot decide, does not.
  const ownerList = await readPendingRequests(
    author.organisationId,
    author.session,
  );
  expect(ownerList).toMatchObject({
    mayDecide: true,
    requests: [
      {
        requestId: pause.id,
        origin: "portal_chat",
        requesterRole: "owner",
        itemLabels: expect.arrayContaining([expect.any(String)]),
      },
    ],
  });
  const viewerList = await readPendingRequests(
    viewer.organisationId,
    viewer.session,
  );
  expect(viewerList).toEqual({ mayDecide: false, requests: [], heldOutputs: [] });

  // 2. A resume before anybody allows the request costs no model step.
  const early = await resumeChat(author, paths.chat, conversationId, pause.id);
  expect(early.status).toBe(409);
  expect(early.body).toMatchObject({ error: "chat_permission_missing" });
  expect(recorded.requests).toHaveLength(askingRequests);

  // 3. One allow in place; the step runs again, reads the draft and answers.
  const allowed = await allowAsPortal(
    author.organisationId,
    author.session,
    pause.id,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  expect(
    await readPendingRequests(author.organisationId, author.session),
  ).toEqual({ mayDecide: true, requests: [], heldOutputs: [] });
  const resumed = await resumeChat(author, paths.chat, conversationId, pause.id);
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
  expect(recorded.turns).toHaveLength(2);
  expect(recorded.deniedReads).toBe(0);
  expect(await answers(author, conversationId)).toEqual([ANSWER]);

  // 4. Without the product read, the draft read asks for it by itself.
  await revokeProductRead(
    author.organisationId,
    author.session,
    "organisation_role",
  );
  const secondChat = newConversationId();
  await createConversation(author, secondChat, route);
  await ask(
    author,
    paths.chat,
    secondChat,
    route.model,
    QUESTION_AGAIN,
    "again",
  );
  const readPause = await pausedRequest(author, paths.chat, secondChat);
  expect(recorded.deniedReads).toBe(1);
  expect(readPause.permission).toMatchObject({
    action: "Read product records",
    items: [
      {
        kind: "agent_request",
        itemId: "commerce.entity.read:product:requester",
      },
    ],
  });
  const readAllowed = await allowAsPortal(
    author.organisationId,
    author.session,
    readPause.id,
  );
  expect(readAllowed.status, await readAllowed.clone().text()).toBe(200);
  const answered = await resumeChat(author, paths.chat, secondChat, readPause.id);
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await expect
    .poll(workKind.bind(null, author, secondChat), { timeout: 60_000 })
    .toBe("ready");
  expect(await answers(author, secondChat)).toEqual([ANSWER]);
  const finished = await storedConversation(author, secondChat);
  expect(JSON.stringify(finished?.conversation.timeline)).not.toContain(ASKED);

  task.meta.chatAgentPermissionRequest = {
    modelRequests: recorded.requests.length,
    toolsAtTurnStart: recorded.turns,
    oneRequest: await readRequest(
      author.organisationId,
      author.session,
      pause.id,
    ),
    deniedReadRequest: await readRequest(
      author.organisationId,
      author.session,
      readPause.id,
    ),
    earlyResume: early,
    ownerPendingList: ownerList,
    viewerPendingList: viewerList,
    events: finished?.conversation.timeline.map((event) => ({
      kind: event.kind,
      text: "text" in event ? event.text : null,
    })),
  };
}

/**
 * Answers each model request from the conversation so far. A large catalogue
 * hides the draft tool behind tool_search, so the model searches first when
 * the tool is not offered. Each answer is recorded for the evidence.
 */
async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const offered = offeredToolNames(body);
  const id = `chat_agent_permission_${String(recorded.requests.length)}`;
  const called = lastCalledTool(body);
  if (called === null) {
    recorded.turns.push(offered);
    if (recorded.turns.length === 1) {
      // The agent lacks the draft tool and sees that it may ask.
      expect(offered).toContain("request_permission");
      expect(offered).not.toContain("product_description_draft_read");
      return openRouterToolCall(
        "request_permission",
        {
          capabilityIds: ["commerce.entity_plane.context"],
          entityTypeReads: ["product"],
        },
        `call_${id}`,
      );
    }
    return offered.includes("product_description_draft_read")
      ? readDraft(id)
      : openRouterToolCall(
          "tool_search",
          { query: "product_description_draft_read" },
          `call_${id}`,
        );
  }
  const output = requireLastToolOutput(body);
  switch (called) {
    case "request_permission":
      expect(output).toContain("Allow prompt");
      return openRouterText(JSON.stringify({ kind: "reply", text: ASKED }), id);
    case "tool_search":
      return readDraft(id);
    case "product_description_draft_read":
      if (output.includes(DESCRIPTION))
        return openRouterText(
          JSON.stringify({ kind: "reply", text: ANSWER }),
          id,
        );
      // The denied read asked for the grant; it does not report missing data.
      expect(output).toContain("Allow prompt");
      expect(output).not.toContain("Commerce read denied");
      recorded.deniedReads += 1;
      return openRouterText(JSON.stringify({ kind: "reply", text: ASKED }), id);
    default:
      throw new Error(`Unexpected tool ${called}`);
  }
}

function readDraft(id: string): Promise<Response> | Response {
  return openRouterToolCall(
    "product_description_draft_read",
    { productId: PRODUCT_ID },
    `call_${id}`,
  );
}
