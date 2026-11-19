// Plan 81 slice 5: the agent proposes the commerce actions that a person can
// take, through the same approvals and receipts. A refund freezes its exact
// money in the proposal, moves nothing before an owner approves it with a
// step-up sign-in, and goes back one time. A price allowance staged in a
// Portal chat changes nothing until the person who asked confirms it on the
// card.
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import { commerceActionTitle } from "../../../../apps/portal/src/features/governed-actions/commerce";
import { parseCommerceActionRecordResponse } from "@purin-labs/control-api/portal/commerce-actions";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { googleConfig } from "../../src/control/google-oidc-config";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { commerceCanonicalResourceId } from "../../src/commerce/provider";
import {
  chat,
  preparePortalChatJourney,
  readWork,
  toolOutput,
} from "./chat-journey-support";
import {
  FakeChatGpt,
  textAnswer,
  type ChatGptAnswer,
} from "./chatgpt-subscription-support";
import { placeCafeOrder, publishCafeMenu, required } from "./cafe-order-support";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  MERCHANT,
  OWNER,
  installEffectAuthority,
  listingNonce,
  postControl,
  providerClient,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";
import { mutationHeaders } from "./access-route-support";

const BASE = `https://localhost/v1/control/organisations/${ORGANISATION_ID}`;
const LATER_THREAD = "1710000200.000100";
const TOOLS =
  "commerce_entity_context commerce_propose_refund commerce_propose_action";

type Script = {
  orderId: string;
  orderRevision: number;
  cookieLineId: string;
};

it("refunds an order only after an owner approves the exact money", async () => {
  await installSlackActorFixture().then(async (fixture) => {
    const slack = slackSimulator();
    const requests: Record<string, unknown>[] = [];
    const script: Script = {
      orderId: "",
      orderRevision: 0,
      cookieLineId: "",
    };
    network.use(
      slack.handler,
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        respond.bind(null, requests, script),
      ),
    );
    const session = await installEffectAuthority(
      fixture.selectedIntegrationAccountId,
      "plugin",
    );
    await givePortalHandles(ORGANISATION_ID);
    await discoverSlackChannel("public_channel", Date.now() - 60_000);
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
    const before = await readPayment(placed);
    expect(before.lifecycle.state).toBe("captured");
    const cookieMoney =
      cookie.lineTotal.amountMinor +
      (order.totals.taxIncluded === true ? 0 : cookie.tax.amountMinor);

    // The agent's wrong proposals are refused in words it can act on.
    await sendListingMessage(
      "app_mention",
      "EvPiRefundFirst",
      ROOT_TS,
      "<@U0PANTRY> The sesame cookie was burnt. Refund it.",
    );
    await expect
      .poll(delivered.bind(null, slack), { timeout: 20_000 })
      .toContain("PI_REFUND_WAITING");
    const nonce = listingNonce(requests);

    // The card reads the record that the approval signs: the exact money.
    const card = parseCommerceActionRecordResponse(
      await (
        await exports.default.fetch(`${BASE}/commerce/actions/${nonce}`, {
          headers: mutationHeaders(session),
        })
      ).json(),
    );
    expect(commerceActionTitle(card.verb)).toBe("Refund order");
    if (card.details.kind !== "refund_order")
      throw new Error(`Unexpected card ${card.details.kind}`);
    expect(card.details.amountMinor).toBe(cookieMoney);
    expect(card.details.lines.map((line) => line.title)).toEqual([
      "Taro Cookie",
    ]);
    expect(card.details.wholeOrder).toBe(false);

    // No money moves before the approval.
    const early = await postControl(
      session,
      `/${nonce}/execute`,
      {},
      "pi-refund-early",
    );
    expect(early.status).toBe(409);
    expect((await readPayment(placed)).lifecycle.state).toBe("captured");

    const result = await approveAndExecute(session, nonce, "refund");
    expect(result).toMatchObject({
      ok: true,
      action: { state: "confirmed" },
      receipt: { projectionKind: "order_refund" },
    });
    const refunded = await readPayment(placed);
    expect(refunded.lifecycle.state).toBe("partially_refunded");
    const replayed = await postControl(
      session,
      `/${nonce}/execute`,
      {},
      "pi-refund-execute",
    );
    expect(await replayed.json()).toEqual(result);
    expect(await readPayment(placed)).toEqual(refunded);

    // After that refund, the whole order cannot go back.
    Object.assign(script, {
      orderRevision: (await readOrder(placed)).revision,
    });
    await sendListingMessage(
      "app_mention",
      "EvPiRefundRest",
      LATER_THREAD,
      "<@U0PANTRY> Refund the rest of the order.",
      LATER_THREAD,
    );
    await expect
      .poll(delivered.bind(null, slack), { timeout: 20_000 })
      .toContain("PI_REFUND_REFUSED");
    expect(await readPayment(placed)).toEqual(refunded);
  });
}, 120_000);

it("stages a price allowance in a Portal chat and applies it only from the asker's card", async () => {
  const offer: { id: string } = { id: "" };
  let step = 0;
  const chatgpt = new FakeChatGpt();
  chatgpt.answer = (): ChatGptAnswer => {
    step += 1;
    switch (step) {
      case 1:
        return toolCall(
          "tool_search",
          { query: "configuration_propose", limit: 1 },
          "pi_allowance_discover",
        );
      case 2:
        return toolCall(
          "configuration_propose",
          {
            request: {
              command: {
                kind: "set_offer_price_allowance",
                offerId: offer.id,
                expectedRevision: null,
                maxMovementBps: 500,
              },
            },
          },
          "pi_allowance_first",
        );
      case 3:
        return textAnswer(
          JSON.stringify({ kind: "reply", text: "Check the card." }),
        );
      case 4:
        return toolCall(
          "tool_search",
          { query: "configuration_propose", limit: 1 },
          "pi_allowance_discover_again",
        );
      case 5:
        return toolCall(
          "configuration_propose",
          {
            request: {
              command: {
                kind: "set_offer_price_allowance",
                offerId: offer.id,
                expectedRevision: null,
                maxMovementBps: 700,
              },
            },
          },
          "pi_allowance_second",
        );
      default:
        return textAnswer(
          JSON.stringify({ kind: "reply", text: "Check the new card." }),
        );
    }
  };
  const { session, fixture } = await preparePortalChatJourney({ chatgpt });
  const owner = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "plugin",
  );
  await provisionShop();
  offer.id = commerceCanonicalResourceId(
    MERCHANT,
    (await readOffer("Taro Cookie")).id,
  );

  // The first card: nothing changes, and Discard leaves it so.
  expect((await chat(session, 1)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 20_000 })
    .toBe("ready");
  const first = await readDrafts(session);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    state: "pending",
    requestedByViewer: true,
    actionLabel: "Save price allowance",
  });
  expect(await allowance(owner, offer.id)).toMatchObject({ kind: "disabled" });
  expect(
    (await decide(session, String(first[0]?.draftId), "cancel")).status,
  ).toBe(200);
  expect((await readDrafts(session))[0]).toMatchObject({ state: "cancelled" });
  expect(await allowance(owner, offer.id)).toMatchObject({ kind: "disabled" });
  const unknown = await decide(session, "draft_not_in_this_chat", "confirm");
  expect(unknown.status).toBe(404);

  // The second card: the person who asked confirms it, one time.
  expect((await chat(session, 2)).status).toBe(200);
  await expect
    .poll(readWork.bind(null, session), { timeout: 20_000 })
    .toBe("ready");
  const second = (await readDrafts(session)).at(-1);
  expect(second).toMatchObject({ state: "pending" });
  const confirmed = await decide(session, String(second?.draftId), "confirm");
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  expect(await confirmed.json()).toMatchObject({
    draft: { state: "settled", receiptCode: "accepted" },
  });
  const set = await allowance(owner, offer.id);
  expect(set).toMatchObject({ maxMovementBps: 700 });
  const again = await decide(session, String(second?.draftId), "confirm");
  expect(again.status).toBe(200);
  expect(await allowance(owner, offer.id)).toEqual(set);
}, 120_000);

function toolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  callId: string,
): ChatGptAnswer {
  return { kind: "tool_call", name, arguments: args, callId };
}

async function readDrafts(
  session: IssuedControlSession,
): Promise<readonly Record<string, unknown>[]> {
  const raw: unknown = await (await chat(session, null)).json();
  if (!isRecord(raw) || !Array.isArray(raw.configurationDrafts))
    throw new Error("No setup changes in the chat read");
  return raw.configurationDrafts as Record<string, unknown>[];
}

async function decide(
  session: IssuedControlSession,
  draftId: string,
  action: "confirm" | "cancel",
): Promise<Response> {
  const conversationId = "conv_719795b9-7490-4476-b8f5-40463dafd29a";
  return exports.default.fetch(
    `${BASE}/chat/conversations/${conversationId}/configuration-drafts/${draftId}/${action}`,
    { method: "POST", headers: mutationHeaders(session), body: "{}" },
  );
}

async function allowance(
  session: IssuedControlSession,
  offerId: string,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    `${BASE}/commerce/offers/${encodeURIComponent(offerId)}/price-policy`,
    { headers: mutationHeaders(session) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const raw: unknown = await response.json();
  if (
    !isRecord(raw) ||
    !isRecord(raw.pricePolicy) ||
    !isRecord(raw.pricePolicy.policy)
  )
    throw new Error(`No price policy: ${JSON.stringify(raw)}`);
  return raw.pricePolicy.policy;
}

async function provisionShop(): Promise<void> {
  const client = providerClient();
  const shop = await client.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!shop.ok) throw new Error(JSON.stringify(shop.error));
}

async function readSnapshot() {
  return required(providerClient().readSnapshot(MERCHANT));
}

async function readOrder(orderId: string) {
  const order = (await readSnapshot()).resources.orders.find(
    (candidate) => candidate.id === orderId,
  );
  if (order === undefined) throw new Error("No order");
  return order;
}

async function readPayment(orderId: string) {
  const payment = (await readSnapshot()).resources.payments.find(
    (candidate) => candidate.orderId === orderId,
  );
  if (payment === undefined) throw new Error("No payment");
  return payment;
}

async function readProduct(title: string) {
  const product = (await readSnapshot()).resources.products.find(
    (candidate) => candidate.title === title,
  );
  if (product === undefined) throw new Error(`No product ${title}`);
  return product;
}

async function readOffer(title: string) {
  const snapshot = await readSnapshot();
  const product = await readProduct(title);
  const variant = snapshot.resources.variants.find(
    (candidate) => candidate.productId === product.id,
  );
  const offer = snapshot.resources.offers.find(
    (candidate) => candidate.variantId === variant?.id,
  );
  if (offer === undefined) throw new Error(`No offer for ${title}`);
  return offer;
}

function delivered(slack: ReturnType<typeof slackSimulator>): string {
  return slack.messages.map((message) => message.text).join("\n");
}

async function approveAndExecute(
  session: IssuedControlSession,
  nonce: string,
  name: string,
): Promise<unknown> {
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
  const config = googleConfig(env);
  if (config === null) throw new Error("Missing approval configuration");
  const grant = await completeCommerceApprovalFixture({
    db: env.DB,
    config,
    action: action.value.action,
    userId: OWNER,
    subject: "e2e-slack-actor",
    email: "e2e-slack-actor@example.invalid",
    stepUpId: `pi-${name}-step-up`,
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    `pi-${name}-approve`,
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const executed = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    `pi-${name}-execute`,
  );
  expect(executed.status, await executed.clone().text()).toBe(200);
  return executed.json();
}

function readEntities(
  seeds: readonly (readonly [string, string])[],
  callId: string,
) {
  const reads = seeds.map(([typeId, entityId]) => ({
    selection: {
      kind: "entity_seeds",
      seeds: [{ origin: "system", typeId, entityId }],
    },
    traversal: { maxDepth: 0, resultLimit: 1 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [],
    freshnessRequirement: "current_only",
  }));
  return openRouterToolCall(
    "codemode",
    {
      code: `let entities = 0;\nfor (const request of ${JSON.stringify(reads)}) {\n  const graph = await tools.commerce_entity_context({ request });\n  if (!graph.ok) throw new Error(graph.error.message);\n  entities += graph.result.entities.length;\n}\ntext("entities=" + entities);`,
    },
    callId,
  );
}

async function respond(
  requests: Record<string, unknown>[],
  script: Script,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid refund model request");
  requests.push(body);
  const last = toolOutput(body);
  const refund = (refundLines: unknown, expectedRevision: number) => ({
    orderId: script.orderId,
    expectedRevision,
    reason: "The cookie was burnt.",
    refundLines,
  });
  switch (requests.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "commerce_entity_context", limit: 1 },
        "pi_refund_discover_read",
      );
    case 2:
      return openRouterToolCall(
        "tool_search",
        { query: TOOLS, limit: 3 },
        "pi_refund_discover",
      );
    case 3:
      return readEntities([["order", script.orderId]], "pi_refund_read");
    case 4:
      expect(last).toContain("entities=1");
      return openRouterToolCall(
        "commerce_propose_refund",
        refund(null, script.orderRevision + 5),
        "pi_refund_unread_revision",
      );
    case 5:
      expect(last).toContain("Read this order");
      return openRouterToolCall(
        "commerce_propose_refund",
        refund(
          [{ orderLineId: "line_not_here", amountMinor: null }],
          script.orderRevision,
        ),
        "pi_refund_wrong_line",
      );
    case 6:
      expect(last).toContain("is not on this order");
      return openRouterToolCall(
        "commerce_propose_refund",
        refund(
          [{ orderLineId: script.cookieLineId, amountMinor: null }],
          script.orderRevision,
        ),
        "pi_refund_cookie",
      );
    case 7:
      expect(last).toContain("commerce_action_proposed");
      return openRouterText("PI_REFUND_WAITING", "pi_refund_waiting");
    case 8:
      return openRouterToolCall(
        "tool_search",
        { query: "commerce_entity_context", limit: 1 },
        "pi_rest_discover_read",
      );
    case 9:
      return openRouterToolCall(
        "tool_search",
        { query: TOOLS, limit: 3 },
        "pi_rest_discover",
      );
    case 10:
      return readEntities([["order", script.orderId]], "pi_rest_read");
    case 11:
      expect(last).toContain("entities=1");
      return openRouterToolCall(
        "commerce_propose_refund",
        refund(null, script.orderRevision),
        "pi_rest_whole",
      );
    case 12:
      expect(last).toContain("cannot take a whole refund");
      return openRouterText("PI_REFUND_REFUSED", "pi_rest_refused");
    default:
      throw new Error(`Unexpected model request ${requests.length}`);
  }
}
