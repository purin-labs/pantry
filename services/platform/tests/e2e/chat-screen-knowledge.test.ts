// Plan 87 J6: Knowledge › Context › On screen lists the pages that the agent
// of a Case received from a person's screen: the page, the time and the
// records on it, and no value from the page. A reader who may not see the
// chat sees none of its pages.
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  type ConversationId,
  type SurfaceObservationV2,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { env } from "cloudflare:workers";

import { resolveActiveCaseActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { opaqueCaseReference } from "@purin-labs/authority/access-control/references";
import { conversationCaseId } from "../../src/chat/conversation-actor-identity";
import { parseCaseId } from "@purin-labs/kernel/ids";
import {
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatScreenKnowledge?: Record<string, unknown>;
  }
}

const INSTANCE = {
  browserInstanceId: "browser-j6",
  surfaceSessionId: "page-session-j6",
  epoch: 0,
};

const COSTS: SurfaceObservationV2 = {
  kind: "surface-observation",
  schemaVersion: 2,
  surface: "costs",
  area: "kitchen",
  instance: INSTANCE,
  title: "Costs & margins",
  path: "/portal/nuki/shop/costs",
  record: null,
  capturedAt: 1_793_100_000_000,
  view: [
    {
      title: "Scenario inputs",
      facts: [{ label: "Shelf waste (spoil)", value: "11%" }],
      table: {
        columns: ["Product", "Net margin"],
        rows: [["Black sesame latte", "61.3%"]],
        totalRows: 1,
      },
    },
  ],
  state: null,
  commands: [],
  sources: [],
};

const ORDER: SurfaceObservationV2 = {
  ...COSTS,
  surface: "orders",
  area: "commerce",
  title: "Orders",
  path: "/portal/nuki/shop/orders/order_1042",
  record: { kind: "customer_order", id: "order_1042", label: "#1042" },
  capturedAt: 1_793_100_060_000,
  view: [],
  sources: [{ kind: "customer_order", id: "order_1042", revision: "3" }],
};

/**
 * Plan 87 J6. The owner's private chat carries Costs & margins and then an
 * order. On screen for its Case lists both pages, newest first, with the
 * time, the open record and the records on screen, and no value from the
 * pages. Another admin, who may not see the private chat, gets an empty list.
 */
it(
  "lists the pages on screen for a Case, with no values, only to readers of its chat",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, reviewer, route, paths } = await installMemoryFixture();
    network.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", reply),
    );
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);
    await sendAndFinish(author, paths.chat, conversationId, route.model, {
      label: "costs",
      text: "What is my shelf waste?",
      surfaceObservation: COSTS,
    });
    await sendAndFinish(author, paths.chat, conversationId, route.model, {
      label: "order",
      text: "Why is this order held?",
      surfaceObservation: ORDER,
    });

    const onScreenPath = await caseOnScreenPath(author, conversationId);
    const ownerRead = await post(author, onScreenPath, null);
    expect(ownerRead.status, await ownerRead.clone().text()).toBe(200);
    const ownerBody: unknown = await ownerRead.json();
    const ownerText = JSON.stringify(ownerBody);
    const observations =
      isRecord(ownerBody) && Array.isArray(ownerBody.observations)
        ? ownerBody.observations
        : [];
    expect(observations).toEqual([
      {
        page: "Orders",
        area: "commerce",
        record: "#1042",
        capturedAt: ORDER.capturedAt,
        sentAt: expect.any(Number),
        sources: [{ kind: "customer_order", id: "order_1042", revision: "3" }],
      },
      {
        page: "Costs & margins",
        area: "kitchen",
        record: null,
        capturedAt: COSTS.capturedAt,
        sentAt: expect.any(Number),
        sources: [],
      },
    ]);
    // No value from a page, and no address.
    expect(ownerText).not.toContain("61.3%");
    expect(ownerText).not.toContain("Shelf waste");
    expect(ownerText).not.toContain("/portal/");

    const otherRead = await post(reviewer, onScreenPath, null);
    expect(otherRead.status, await otherRead.clone().text()).toBe(200);
    expect(await otherRead.json()).toEqual({ ok: true, observations: [] });

    task.meta.chatScreenKnowledge = {
      ownerOnScreen: ownerBody,
      otherAdminOnScreen: { ok: true, observations: [] },
    };
  },
);

/** The On screen route of the chat's Case, by its opaque reference. */
async function caseOnScreenPath(
  author: Member,
  conversationId: ConversationId,
): Promise<string> {
  const stored = await storedConversation(author, conversationId);
  if (stored === null) throw new Error("The chat is missing");
  const caseId = parseCaseId(await conversationCaseId(stored.actorIdentity));
  if (!caseId.ok) throw new Error(caseId.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: author.organisationId,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const reference = await opaqueCaseReference(
    author.organisationId,
    caseId.value,
  );
  return `/v1/control/organisations/${author.organisationId}/case-context-discovery/screen-observations?case_ref=${reference}&revision=${snapshot.value.revision}`;
}

async function sendAndFinish(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  message: Readonly<{
    label: string;
    text: string;
    surfaceObservation: SurfaceObservationV2;
  }>,
): Promise<void> {
  const response = await post(author, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${message.label}`,
    model,
    text: message.text,
    browserContext: { kind: "unavailable" },
    surfaceObservation: message.surfaceObservation,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
}

function reply(_request: Parameters<HttpResponseResolver>[0]): Response {
  return openRouterText("Noted.", "j6_reply");
}
