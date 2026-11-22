// Plan 77 step 4, the Pantry part: in a Slack thread the merchant states a
// requirement, Sous Chef writes a merchant plugin for it, and Platform records the
// installation as a governed action. Nothing reaches Commerce before an
// owner approves with a step-up sign-in; then Commerce installs exactly the
// approved code and settings, once, and the thread gets the outcome. A changed
// requirement in a later turn of the same thread proposes version 2 against
// the installed revision, so a plugin cannot change without a second approval.
// A third turn proposes a loyalty plugin with an event handler and no
// checkout rule. Its first draft keeps a text note on each customer, which
// is refused; the second marks a regular with a yes or no. Commerce
// installs the approved handler, its commands and the customer field.
// Each proposal also puts a fixed notice in the thread, whatever the agent
// writes: what waits for approval, and the link to its approval card.
// Before each approval the owner's card runs the proposed rule over the
// shop's recent checkouts: a buyer's pickup with 15 minutes' notice is one
// that the 48-hour rule, and then the 72-hour rule, would refuse.
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import { CommerceStorefrontClient } from "@purin-labs/commerce-client";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { googleConfig } from "../../src/control/google-oidc-config";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  MERCHANT,
  OWNER,
  installEffectAuthority,
  lastListingToolText,
  listingNonce,
  postControl,
  providerClient,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";

// The cafe demo's cookie stands in for a whole cake: it is ready for
// pickup 15 minutes after the order. The demo's own stock has expired, so
// the journey receives a fresh box first.
const WHOLE_CAKE = "variant_sesame_cookie";

const NOTICE_RULE = `function run(input) {
  const notice = Date.parse(input.checkout.readyBy) - Date.parse(input.checkout.quotedAt);
  const refusals = [];
  for (const line of input.checkout.lines)
    if (input.settings.wholeCakeVariantIds.includes(line.variantId) &&
        notice < input.settings.noticeHours * 3600000)
      refusals.push({ message: line.title + " needs " + input.settings.noticeHours + " hours' notice." });
  return { refusals };
}`;

const THIRD_ORDER = `function run(input) {
  const order = input.order;
  if (order === null || order.buyer.kind !== "identified" ||
      order.buyer.placedOrders % 3 !== 0) return {};
  return { commands: [
    { kind: "credit_store_credit", orderId: order.id,
      amountMinor: input.settings.creditMinor },
    { kind: "set_plugin_field_values", entityType: "customer",
      orderId: order.id, values: { regular: true } },
  ] };
}`;

const REGULAR = {
  entityType: "customer",
  key: "regular",
  valueKind: "boolean",
  description: "A buyer who reached a third order",
} as const;

const loyalty = (field: Record<string, string>) => ({
  pluginId: "loyalty",
  title: "Third order credit",
  purpose: "Regulars get ¥300 store credit at every third order.",
  settings: [
    {
      key: "creditMinor",
      valueKind: "integer",
      description: "Store credit for every third order",
      value: 300,
    },
  ],
  functionSource: null,
  commands: ["credit_store_credit", "set_plugin_field_values"],
  handlers: [
    {
      handlerId: "third_order",
      eventKinds: ["order.created"],
      source: THIRD_ORDER,
    },
  ],
  actions: [],
  entityTypes: [],
  fields: [field],
});

function cakeNotice(noticeHours: number) {
  return {
    pluginId: "cake_notice",
    title: "Whole cake notice",
    purpose: `A whole cake needs ${noticeHours} hours' notice for pickup.`,
    settings: [
      {
        key: "wholeCakeVariantIds",
        valueKind: "text_list",
        description: "Variants that are whole cakes",
        value: [WHOLE_CAKE],
      },
      {
        key: "noticeHours",
        valueKind: "integer",
        description: "Hours of notice for a whole cake",
        value: noticeHours,
      },
    ],
    functionSource: NOTICE_RULE,
    commands: [],
    handlers: [],
    actions: [],
    entityTypes: [],
    fields: [],
  };
}

it("installs an agent-written merchant plugin only after an owner approves each version", async ({
  task,
}) => {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respond.bind(null, requests),
    ),
  );
  const session = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "plugin",
  );
  await givePortalHandles(ORGANISATION_ID);
  await openShopWithOnePickup();
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "merchant-plugin",
      requests,
      delivered: slack.messages,
    },
  });

  await sendListingMessage(
    "app_mention",
    "EvPiPluginFirst",
    ROOT_TS,
    "<@U0PANTRY> A whole cake needs 48 hours' notice for pickup. Set that up for approval.",
  );
  // The notice and the agent's reply.
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  expect(notices(slack.messages)).toEqual([
    {
      change: 'Install the "Whole cake notice" plugin: Version 1',
      nonce: listingNonce(requests),
    },
  ]);
  const first = await approveAndInstall(
    session,
    listingNonce(requests),
    "first",
  );
  expect(first.preview).toEqual({
    kind: "previewed",
    checkouts: 1,
    refusals: [
      { message: "Sesame Cookie needs 48 hours' notice.", checkouts: 1 },
    ],
    failures: [],
  });
  expect(first.plugin).toMatchObject({
    pluginId: "cake_notice",
    version: 1,
    state: "active",
    title: "Whole cake notice",
  });
  expect(first.plugin.contributions.functions).toEqual([
    {
      functionId: "check_checkout",
      hookPoint: "checkout.validate",
      required: false,
      source: NOTICE_RULE,
    },
  ]);
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 15_000 })
    .toContain("Purin Pantry made the change.");

  // A later turn of the same thread proposes too; its own turn binds it.
  await sendListingMessage(
    "message",
    "EvPiPluginSecond",
    "1787500000.000300",
    "Whole cakes now need 72 hours' notice. Change the plugin for approval.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(4);
  expect(notices(slack.messages).at(-1)).toEqual({
    change: 'Install the "Whole cake notice" plugin: Version 2',
    nonce: listingNonce(requests),
  });
  const second = await approveAndInstall(
    session,
    listingNonce(requests),
    "second",
  );
  expect(second.details).toMatchObject({
    kind: "install_merchant_plugin",
    version: 2,
    expectedRevision: first.plugin.revision,
  });
  expect(second.preview).toMatchObject({
    checkouts: 1,
    refusals: [
      { message: "Sesame Cookie needs 72 hours' notice.", checkouts: 1 },
    ],
  });
  expect(second.plugin).toMatchObject({ version: 2, state: "active" });
  expect(second.plugin.purpose).toBe(
    "A whole cake needs 72 hours' notice for pickup.",
  );
  await expect
    .poll(() => slack.messages[2]?.text, { timeout: 15_000 })
    .toContain("Purin Pantry made the change.");

  // A plugin with an event handler and no checkout rule.
  await sendListingMessage(
    "message",
    "EvPiPluginThird",
    "1787500000.000500",
    "Give regulars ¥300 store credit at every third order. Set that up for approval.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(6);
  // The two decided cards no longer wait; each shows its decision.
  expect(notices(slack.messages)).toHaveLength(1);
  const third = await approveAndInstall(
    session,
    listingNonce(requests),
    "third",
    "loyalty",
  );
  expect(third.plugin).toMatchObject({
    pluginId: "loyalty",
    version: 1,
    state: "active",
    requirements: {
      hookPoints: [],
      commands: ["credit_store_credit", "set_plugin_field_values"],
    },
    fields: [REGULAR],
    handlers: [
      {
        handlerId: "third_order",
        eventKinds: ["order.created"],
        source: THIRD_ORDER,
      },
    ],
  });
  expect(third.details).toMatchObject({ fields: [REGULAR] });
  expect(third.preview).toEqual({ kind: "no_checkout_function" });
  expect(third.plugin.contributions.functions).toEqual([]);
  await expect
    .poll(() => slack.messages[4]?.text, { timeout: 15_000 })
    .toContain("Purin Pantry made the change.");
});

/** Each approval notice in the thread: the change and the linked action. */
function notices(messages: readonly Record<string, string>[]) {
  return messages.flatMap((message) => {
    const change = /^\*(.+)\*\n(.+)\n\nNothing changes until/u.exec(
      message.text ?? "",
    );
    const blocks: unknown = JSON.parse(message.blocks ?? "[]");
    const nonce =
      /"action_id":"commerce_action_approve".*?"value":"([^"]+)"/u.exec(
        JSON.stringify(blocks),
      );
    return change === null || nonce === null
      ? []
      : [{ change: `${change[1]}: ${change[2]}`, nonce: nonce[1] }];
  });
}

/**
 * Reads the card's preview, checks that nothing reaches Commerce before
 * the approval, approves with a step-up sign-in, executes, and returns the
 * installed plugin with the preview.
 */
async function approveAndInstall(
  session: IssuedControlSession,
  nonce: string,
  name: string,
  pluginId = "cake_notice",
) {
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
  const previewed = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/actions/${nonce}/plugin-preview`,
    {
      headers: {
        origin: "https://localhost",
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
      },
    },
  );
  expect(previewed.status, await previewed.clone().text()).toBe(200);
  const preview: unknown = await previewed.json();
  if (!isRecord(preview)) throw new Error("Missing plugin preview");
  const before = await installedPlugin(pluginId);
  const early = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    `pi-plugin-${name}-early`,
  );
  expect(early.status).toBe(409);
  expect(await installedPlugin(pluginId)).toEqual(before);

  const config = googleConfig(env);
  if (config === null) throw new Error("Missing approval configuration");
  const grant = await completeCommerceApprovalFixture({
    db: env.DB,
    config,
    action: action.value.action,
    userId: OWNER,
    subject: "e2e-slack-actor",
    email: "e2e-slack-actor@example.invalid",
    stepUpId: `pi-plugin-${name}-step-up`,
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    `pi-plugin-${name}-approve`,
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const executed = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    `pi-plugin-${name}-execute`,
  );
  expect(executed.status, await executed.clone().text()).toBe(200);
  const result: unknown = await executed.json();
  expect(result).toMatchObject({
    ok: true,
    action: { state: "confirmed" },
    receipt: { resourceId: pluginId, projectionKind: "merchant_plugin" },
  });
  // A repeated execution replays the receipt and installs nothing new.
  const replayed = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    `pi-plugin-${name}-execute`,
  );
  expect(await replayed.json()).toEqual(result);
  const plugin = await installedPlugin(pluginId);
  if (plugin === undefined) throw new Error("The plugin was not installed");
  if (!isRecord(result) || !isRecord(result.action))
    throw new Error("Missing executed action");
  return { plugin, details: result.action.details, preview: preview.preview };
}

/** The cafe demo shop, and a buyer's pickup checkout of one cookie. */
async function openShopWithOnePickup(): Promise<void> {
  const provisioned = await providerClient().provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
  const shop = provisioned.value;
  const item = shop.resources.inventoryItems.find(
    (candidate) => candidate.id === "inventory_sesame_cookie",
  );
  const position = shop.resources.inventoryPositions.find(
    (candidate) => candidate.inventoryItemId === "inventory_sesame_cookie",
  );
  if (item === undefined || position === undefined)
    throw new Error("The cafe demo has no cookie stock");
  const now = new Date().toISOString();
  const received = await providerClient().receiveInventory({
    purchase: { kind: "unlinked" },
    merchantId: MERCHANT,
    expectedMerchantRevision: shop.merchantRevision,
    idempotencyKey: "pi-plugin-cookies",
    receiptId: "receipt_pi_plugin_cookies",
    receiptLineId: "1",
    inventoryItemId: item.id,
    inventoryItemRevision: item.revision,
    inventoryPositionId: position.id,
    inventoryPositionRevision: position.revision,
    locationId: position.locationId,
    receivedQuantity: { amount: 12, scale: 0, unit: "each" },
    lot: {
      kind: "tracked",
      lotId: "lot_pi_plugin_cookies",
      lotCode: "PI-PLUGIN",
      expiry: {
        kind: "expires",
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
    },
    receivedAt: now,
  });
  if (!received.ok) throw new Error(JSON.stringify(received.error));
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://commerce.test",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const session = await buyer.createSession(MERCHANT, "storefront_cafe", {
    schemaVersion: "commerce.create-buyer-session.v1",
    buyer: { kind: "guest" },
  });
  if (!session.ok) throw new Error(JSON.stringify(session.error));
  const cart = await buyer.createCart(
    MERCHANT,
    "storefront_cafe",
    session.value.token,
    {
      schemaVersion: "commerce.create-buyer-cart.v1",
      idempotencyKey: "pi-plugin-cart",
      lines: [{ kind: "catalog", variantId: WHOLE_CAKE, quantity: 1 }],
    },
  );
  if (!cart.ok) throw new Error(JSON.stringify(cart.error));
  const checkout = await buyer.createPickupCheckout(
    MERCHANT,
    "storefront_cafe",
    session.value.token,
    {
      schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
      idempotencyKey: "pi-plugin-checkout",
      cartId: cart.value.cartId,
      cartRevision: cart.value.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: "buyer@example.test" },
      },
    },
  );
  if (!checkout.ok) throw new Error(JSON.stringify(checkout.error));
}

async function installedPlugin(pluginId: string) {
  const listed = await providerClient().listPlugins(MERCHANT);
  if (!listed.ok) throw new Error(JSON.stringify(listed.error));
  return listed.value.plugins.find((plugin) => plugin.pluginId === pluginId);
}

async function respond(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid plugin model request");
  requests.push(body);
  switch (requests.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "commerce_propose_plugin", limit: 1 },
        "pi_plugin_discover",
      );
    case 2:
      return openRouterToolCall(
        "commerce_propose_plugin",
        { request: cakeNotice(48) },
        "pi_plugin_propose_first",
      );
    case 3: {
      const result = lastListingToolText(body);
      expect(result).toContain("commerce_action_proposed");
      expect(result).toContain('"checkouts":1');
      // The thread shows the card, so the agent does not repeat its link.
      expect(result).toContain("approval card");
      expect(result).not.toContain("commerceAction=");
      return openRouterText("PI_PLUGIN_AWAITING_APPROVAL", "pi_plugin_waiting");
    }
    case 4:
      return openRouterToolCall(
        "commerce_propose_plugin",
        { request: cakeNotice(72) },
        "pi_plugin_propose_second",
      );
    case 5:
      expect(lastListingToolText(body)).toContain('"version":2');
      return openRouterText(
        "PI_PLUGIN_VERSION_AWAITING_APPROVAL",
        "pi_plugin_waiting_second",
      );
    case 6:
      return openRouterToolCall(
        "commerce_propose_plugin",
        {
          request: loyalty({
            ...REGULAR,
            key: "note",
            valueKind: "text",
            description: "What staff know about the buyer",
          }),
        },
        "pi_plugin_propose_note",
      );
    case 7: {
      // A plugin cannot keep free text about a person.
      const result = lastListingToolText(body);
      expect(result).toContain("commerce_action_invalid");
      expect(result).toContain("fields");
      return openRouterToolCall(
        "commerce_propose_plugin",
        { request: loyalty(REGULAR) },
        "pi_plugin_propose_third",
      );
    }
    case 8: {
      // A plugin with no checkout rule has no checkout preview.
      const result = lastListingToolText(body);
      expect(result).toContain("commerce_action_proposed");
      expect(result).toContain('"preview":null');
      return openRouterText(
        "PI_PLUGIN_LOYALTY_AWAITING_APPROVAL",
        "pi_plugin_waiting_third",
      );
    }
    default:
      throw new Error("Unexpected plugin model request");
  }
}
