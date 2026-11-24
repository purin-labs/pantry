// The Portal chat agent sees the Portal page that the person has on the
// screen when they send a message from the side chat, unsaved edits
// included (owner's request, 2026-11-06), when every reader of the chat may
// open that page (Plan 87 J3).
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  type ConversationId,
  type SurfaceObservationV2,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { answers } from "./chat-permission-support";
import {
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";
import { finished, latestUserInput } from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatPageView?: Record<string, unknown>;
  }
}

/** The Costs & margins page with a spoil rate that the owner has not saved. */
const COSTS_OBSERVATION: SurfaceObservationV2 = {
  kind: "surface-observation",
  schemaVersion: 2,
  surface: "costs",
  area: "kitchen",
  instance: {
    browserInstanceId: "browser-j3",
    surfaceSessionId: "costs-session",
    epoch: 0,
  },
  title: "Costs & margins",
  path: "/portal/nuki/shop/costs",
  record: null,
  capturedAt: 1_793_000_000_000,
  view: [
    {
      title: "Page state",
      facts: [
        { label: "Open tab", value: "1. Product Margins" },
        {
          label: "Unsaved changes",
          value: "Yes: the values below include edits that are not saved",
        },
      ],
      table: null,
    },
    {
      title: "Scenario inputs",
      facts: [{ label: "Shelf waste (spoil)", value: "11%" }],
      table: null,
    },
    {
      title: "Product margins table (rows in view)",
      facts: [],
      table: {
        columns: ["Product", "Units per day", "Price", "Net margin"],
        rows: [["Black sesame latte", "28", "¥680", "61.3%"]],
        totalRows: 1,
      },
    },
  ],
  state: null,
  commands: [],
  sources: [],
};

/** Orders with one order open: a page that only a private chat may carry. */
const ORDER_OBSERVATION: SurfaceObservationV2 = {
  ...COSTS_OBSERVATION,
  surface: "orders",
  area: "commerce",
  title: "Orders",
  path: "/portal/nuki/shop/orders/order_1042",
  record: { kind: "customer_order", id: "order_1042", label: "#1042" },
  view: [],
};

/**
 * Plan 87 J3. The page on the sender's screen reaches the model only when
 * every reader of the chat may open it. A private chat carries any page. A
 * chat shared with a Project carries Costs & margins, which every member may
 * open, and leaves Orders out. The chat keeps the page where it started:
 * a later message from another page does not move it. An observation that
 * breaks the contract refuses the message, also one whose text passes a
 * limit only when it is counted in grapheme clusters.
 */
it(
  "gives the chat agent the page on screen only when the chat's readers may open it",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, reviewer, route, paths } = await installMemoryFixture();
    const requests: string[] = [];
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        recordAndReply.bind(null, requests),
      ),
    );
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);

    // The private chat carries the page on screen.
    const privateCosts = await send(
      author,
      paths.chat,
      conversationId,
      route.model,
      {
        label: "costs",
        text: "What spoil rate do I have on screen?",
        surfaceObservation: COSTS_OBSERVATION,
      },
    );
    expect(privateCosts.status, await privateCosts.clone().text()).toBe(200);
    await finished(author, conversationId);
    const privateInput = latestUserInput(requests);
    expect(privateInput).toContain("Portal page on the operator's screen");
    expect(privateInput).toContain("Shelf waste (spoil)");
    expect(privateInput).toContain("Black sesame latte");
    expect(privateInput).toContain("edits that are not saved");

    const malformed = await send(
      author,
      paths.chat,
      conversationId,
      route.model,
      {
        label: "bad",
        text: "And now?",
        surfaceObservation: { ...COSTS_OBSERVATION, path: "costs" },
      },
    );
    expect(malformed.status).toBe(422);

    // One letter with 1,000 combining marks is one grapheme cluster but
    // 1,001 characters: over the 400 characters of a page cell, so the
    // message is refused before any model call.
    const modelCalls = requests.length;
    const stacked = await send(
      author,
      paths.chat,
      conversationId,
      route.model,
      {
        label: "stacked-marks",
        text: "And this note?",
        surfaceObservation: {
          ...COSTS_OBSERVATION,
          view: [
            {
              title: "Page state",
              facts: [{ label: "Note", value: `a${"́".repeat(1_000)}` }],
              table: null,
            },
          ],
        },
      },
    );
    expect(stacked.status).toBe(422);
    expect(requests.length).toBe(modelCalls);

    const shared = await sharedConversation(
      author,
      route,
      paths.projects,
      reviewer,
    );
    const sharedCosts = await send(author, paths.chat, shared, route.model, {
      label: "shared-costs",
      text: "What spoil rate is on my screen now?",
      surfaceObservation: COSTS_OBSERVATION,
    });
    expect(sharedCosts.status, await sharedCosts.clone().text()).toBe(200);
    await finished(author, shared);
    const sharedCostsInput = latestUserInput(requests);
    expect(sharedCostsInput).toContain("spoil rate is on my screen now?");
    expect(sharedCostsInput).toContain("Shelf waste (spoil)");

    const sharedOrder = await send(author, paths.chat, shared, route.model, {
      label: "shared-order",
      text: "Why is this order held?",
      surfaceObservation: ORDER_OBSERVATION,
    });
    expect(sharedOrder.status, await sharedOrder.clone().text()).toBe(200);
    await finished(author, shared);
    const sharedOrderInput = latestUserInput(requests);
    expect(sharedOrderInput).toContain("Why is this order held?");
    // The chat started on Costs & margins, and the agent still reads that.
    expect(sharedOrderInput).toContain("This chat started on Costs & margins");
    expect(sharedOrderInput).toContain(
      "The current request carries no page from the operator's screen",
    );
    expect(sharedOrderInput).not.toContain("#1042");
    // The message keeps only its text: no page went with it.
    const stored = await storedConversation(author, shared);
    const orderMessage = stored?.conversation.timeline.findLast(
      (event) => event.kind === "user",
    );
    expect(
      orderMessage?.kind === "user"
        ? orderMessage.parts.map((part) => part.kind)
        : [],
    ).not.toContain("surface_observation");

    task.meta.chatPageView = {
      privateChatModelInput: privateInput,
      malformedStatus: malformed.status,
      stackedMarksStatus: stacked.status,
      sharedChatCostsModelInput: sharedCostsInput,
      sharedChatOrdersModelInput: sharedOrderInput,
      answers: await answers(author, conversationId),
    };
  },
);

/** A new chat of the owner, shared with a Project that has a viewer. */
async function sharedConversation(
  author: Member,
  route: Parameters<typeof createConversation>[2],
  projectsPath: string,
  viewer: Member,
): Promise<ConversationId> {
  const projectId = newProjectId();
  const created = await post(author, projectsPath, {
    kind: "create_project",
    operationId: crypto.randomUUID(),
    projectId,
    content: { name: "Costs review", brief: "", references: [] },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const access = await post(author, `${projectsPath}/${projectId}/access`, {
    kind: "share_project",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 0,
    members: [{ userId: viewer.userId, role: "viewer" }],
  });
  expect(access.status, await access.clone().text()).toBe(200);
  const conversationId = newConversationId();
  await createConversation(author, conversationId, route);
  const stored = await storedConversation(author, conversationId);
  if (stored === null) throw new Error("The new chat is missing");
  const sharing = await post(
    author,
    `${projectsPath.replace(/projects$/u, "chat")}/conversations/${conversationId}/access`,
    {
      kind: "share_conversation",
      operationId: crypto.randomUUID(),
      expectedRevision: stored.revision,
      projectId,
      expectedProjectAccessRevision: 1,
    },
  );
  expect(await sharing.json()).toMatchObject({ kind: "accepted" });
  return conversationId;
}

function send(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  message: Readonly<{
    label: string;
    text: string;
    surfaceObservation?: unknown;
  }>,
): Promise<Response> {
  return post(author, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${message.label}`,
    model,
    text: message.text,
    browserContext: { kind: "unavailable" },
    ...(message.surfaceObservation === undefined
      ? {}
      : { surfaceObservation: message.surfaceObservation }),
  });
}

async function recordAndReply(
  requests: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(JSON.stringify(body));
  return openRouterText(
    "Your screen shows the plan.",
    `page_view_${String(requests.length)}`,
  );
}
