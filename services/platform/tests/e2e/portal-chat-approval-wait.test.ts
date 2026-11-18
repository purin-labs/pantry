// A Portal chat waits for a decision on its agent's approval card. In a
// Portal chat the agent proposes a refund, and the chat's Case waits for an
// owner. A new message while the card waits is refused in words that the
// person can act on, and no model request leaves. The card then expires
// before anybody decides it: the owner can no longer decline it, and a retry
// of the refused message runs. The agent then makes a new card, which waits
// for the owner. Production saw the missing half on 2026-11-05: after
// an unanswered price card expired, every message in that chat failed with
// "The selected AI could not finish this response".
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import {
  placeCafeOrder,
  publishCafeMenu,
  required,
} from "./cafe-order-support";
import {
  CONVERSATION_ID,
  preparePortalChatJourney,
} from "./chat-journey-support";
import { network } from "./network";
import {
  MERCHANT,
  OWNER,
  installEffectAuthority,
  listingNonce,
  postControl,
  providerClient,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

const TOOLS =
  "commerce_entity_context commerce_propose_refund commerce_propose_action";
const WAITING_MESSAGE =
  "This chat waits for a decision on its approval card. Approve or reject the card, then send your message again.";

type Script = {
  orderId: string;
  orderRevision: number;
  cookieLineId: string;
};

it(
  "refuses a new Portal message while its approval card waits, and runs it again after the card expires",
  approvalWaitJourney,
  180_000,
);

async function approvalWaitJourney({ task }: TestContext): Promise<void> {
  const { session, fixture } = await preparePortalChatJourney();
  await choosePantryPlatform();
  const requests: Record<string, unknown>[] = [];
  const script: Script = { orderId: "", orderRevision: 0, cookieLineId: "" };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respond.bind(null, requests, script),
    ),
  );
  await installEffectAuthority(fixture.selectedIntegrationAccountId, "plugin");
  await provisionShop();
  await publishCafeMenu(MERCHANT);
  const placed = await placeCafeOrder(MERCHANT);
  const order = await readOrder(placed);
  const cookie = order.lineItems.find((line) => line.title === "Taro Cookie");
  if (cookie === undefined) throw new Error("No cookie line");
  Object.assign(script, {
    orderId: order.id,
    orderRevision: order.revision,
    cookieLineId: cookie.id,
  });

  // Turn 1: the agent proposes a refund. The chat ends; the card waits.
  expect(
    (await sendMessage(session, 1, "Refund the burnt cookie.")).status,
  ).toBe(200);
  const first = await settledWork(session);
  expect(first).toMatchObject({ kind: "ready" });
  const firstNonce = listingNonce(requests);
  expect(await actionState(firstNonce)).toBe("proposed");
  const firstTurnCalls = requests.length;

  // Turn 2 while the card waits: refused in words the person can act on,
  // and no model request leaves.
  expect((await sendMessage(session, 2, "Also check the stock.")).status).toBe(
    200,
  );
  const refused = await settledWork(session);
  expect(refused).toMatchObject({ kind: "failed", error: WAITING_MESSAGE });
  expect(requests).toHaveLength(firstTurnCalls);

  // Nobody decides the card before it expires. Then nobody can decline it.
  await expireAction(firstNonce);
  const decline = await postControl(
    session,
    `/${firstNonce}/rejection`,
    { reason: "merchant_declined" },
    "approval-wait-late-decline",
  );
  const declineBody = await decline.text();
  expect(decline.status, declineBody).toBe(409);
  expect(declineBody).toContain("action_expired");
  expect(await actionState(firstNonce)).toBe("expired");

  // The person retries the refused message, as Portal offers: the turn runs
  // again, and the agent makes a new card.
  const retried = await retryMessage(session, 2);
  expect(retried.status, await retried.clone().text()).toBe(200);
  const resumed = await settledWork(session);
  expect(resumed).toMatchObject({ kind: "ready" });
  expect(requests.length).toBeGreaterThan(firstTurnCalls);
  const secondNonce = listingNonce(requests);
  expect(secondNonce).not.toBe(firstNonce);
  expect(await actionState(secondNonce)).toBe("proposed");
  const transcript = await (await readChat(session)).text();
  expect(transcript).toContain("APPROVAL_WAIT_FIRST_CARD");
  expect(transcript).toContain("APPROVAL_WAIT_SECOND_CARD");

  Object.assign(task.meta, {
    portalChatApprovalWait: {
      substituted: ["model provider (deterministic OpenRouter transport)"],
      real: [
        "Satyr Worker",
        "Case Actor",
        "action ledger",
        "Underclerk fixture",
      ],
      faultInjected: "the first card's expiry time moved to the past",
      firstCard: { nonce: firstNonce, stateAfterExpiry: "expired" },
      refusedWhileWaiting: refused,
      lateDecline: { status: decline.status, body: declineBody },
      resumedTurn: resumed,
      secondCard: { nonce: secondNonce, state: "proposed" },
      modelRequests: requests.length,
    },
  });
}

async function respond(
  requests: Record<string, unknown>[],
  script: Script,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(body);
  const refund = {
    orderId: script.orderId,
    expectedRevision: script.orderRevision,
    reason: "The cookie was burnt.",
    refundLines: [{ orderLineId: script.cookieLineId, amountMinor: null }],
  };
  // Each card turn makes the same five calls; the second turn's calls start
  // after the first turn's.
  const step = requests.length;
  const turn = step <= 5 ? "first" : "second";
  switch ((step - 1) % 5) {
    case 0:
      return openRouterToolCall(
        "tool_search",
        { query: "commerce_entity_context", limit: 1 },
        `approval_wait_${turn}_discover_read`,
      );
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: TOOLS, limit: 3 },
        `approval_wait_${turn}_discover`,
      );
    case 2:
      return readOrderCall(script.orderId, `approval_wait_${turn}_read`);
    case 3:
      expect(toolOutput(body)).toContain("entities=1");
      return openRouterToolCall(
        "commerce_propose_refund",
        refund,
        `approval_wait_${turn}_refund`,
      );
    default:
      expect(toolOutput(body)).toContain("commerce_action_proposed");
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text:
            turn === "first"
              ? "APPROVAL_WAIT_FIRST_CARD"
              : "APPROVAL_WAIT_SECOND_CARD",
        }),
        `approval_wait_${turn}_reply`,
      );
  }
}

function readOrderCall(orderId: string, callId: string): Response {
  const read = {
    selection: {
      kind: "entity_seeds",
      seeds: [{ origin: "system", typeId: "order", entityId: orderId }],
    },
    traversal: { maxDepth: 0, resultLimit: 1 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [],
    freshnessRequirement: "current_only",
  };
  return openRouterToolCall(
    "codemode",
    {
      code: `const graph = await tools.commerce_entity_context({ request: ${JSON.stringify(read)} });\nif (!graph.ok) throw new Error(graph.error.message);\ntext("entities=" + graph.result.entities.length);`,
    },
    callId,
  );
}

function toolOutput(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = messages.filter(
    (message) => isRecord(message) && message.role === "tool",
  );
  const last = tools.at(-1);
  return isRecord(last) ? JSON.stringify(last.content) : "";
}

/** Moves the action's expiry into the past, as 15 minutes of waiting does. */
async function expireAction(nonce: string): Promise<void> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  await runInDurableObject(organisation, (_actor, state) => {
    const created = state.storage.sql
      .exec<{ created_at: number }>(
        "SELECT created_at FROM action_ledger WHERE nonce = ?",
        nonce,
      )
      .one().created_at;
    state.storage.sql.exec(
      "UPDATE action_ledger SET expires_at = ? WHERE nonce = ?",
      created,
      nonce,
    );
  });
}

async function actionState(nonce: string): Promise<string> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  return action.value.state;
}

async function settledWork(
  session: IssuedControlSession,
): Promise<Record<string, unknown>> {
  let work: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const raw: unknown = await (await readChat(session)).json();
        work =
          isRecord(raw) &&
          isRecord(raw.conversation) &&
          isRecord(raw.conversation.work)
            ? raw.conversation.work
            : {};
        return work.kind;
      },
      { timeout: 45_000, interval: 250 },
    )
    .toMatch(/^(ready|failed)$/u);
  return work;
}

async function choosePantryPlatform(): Promise<void> {
  const selection = await readOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  if (selection === null) throw new Error("Missing inference authority");
  const selected = await selectOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    selection: { kind: "satyr_platform" },
    expectedConfigurationVersion: selection.configurationVersion,
    selectedByUserId: OWNER,
    now: Date.now(),
  });
  if (!selected.ok) throw new Error(selected.error.code);
}

function sendMessage(
  session: IssuedControlSession,
  turn: number,
  text: string,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      method: "POST",
      headers: headers(session),
      body: JSON.stringify({
        kind: "message",
        conversationId: CONVERSATION_ID,
        requestId: `request_approval_wait_${turn}`,
        model: "moonshotai/kimi-k3",
        text,
        surfaceContext: null,
      }),
    },
  );
}

function retryMessage(
  session: IssuedControlSession,
  turn: number,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      method: "POST",
      headers: headers(session),
      body: JSON.stringify({
        kind: "retry",
        conversationId: CONVERSATION_ID,
        requestId: `request_approval_wait_${turn}`,
        model: "moonshotai/kimi-k3",
      }),
    },
  );
}

function readChat(session: IssuedControlSession): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=${CONVERSATION_ID}`,
    { headers: headers(session) },
  );
}

function headers(session: IssuedControlSession): Record<string, string> {
  return {
    origin: "https://localhost",
    "content-type": "application/json",
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
  };
}

async function provisionShop(): Promise<void> {
  const shop = await providerClient().provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!shop.ok) throw new Error(JSON.stringify(shop.error));
}

async function readOrder(orderId: string) {
  const snapshot = await required(providerClient().readSnapshot(MERCHANT));
  const order = snapshot.resources.orders.find(
    (candidate) => candidate.id === orderId,
  );
  if (order === undefined) throw new Error("No order");
  return order;
}
