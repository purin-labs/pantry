import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import type { CommerceProjection } from "@purin-labs/commerce-contracts";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import { commerceCanonicalResourceId } from "@purin-labs/area-commerce-contract/server/resource-ids";
import { mutationHeaders } from "./access-route-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  MERCHANT,
  OFFER,
  PRODUCT,
  SALES_CHANNEL,
  VARIANT,
  installEffectAuthority,
  lastListingToolText,
  listingNonce,
  listingProvenance,
  providerClient,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import { signedButtonClick } from "./slack-side-case-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  cardButtons,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackOfferPriceChange?: Record<string, unknown>;
  }
}

/**
 * A Slack request to change a listed price, from the request to the price
 * that the shop shows after an owner's approval.
 *
 * The cookie box is listed at ¥2,400, and an owner set a price allowance of
 * 20 % in the Portal. An owner asks the Slack agent for ¥2,600. The agent
 * reads the offer: the read shows the price, the allowance, its revision and
 * the range it allows now. The agent's first proposal also fills reason,
 * which a price change does not take: the refusal names that field, nothing
 * reaches the thread, and the agent proposes again without it. The approval
 * card then waits for a click. The shop keeps ¥2,400 until the owner clicks Approve. Then the shop
 * charges ¥2,600, the one card shows the decision, and the agent's next
 * read in the thread shows ¥2,600 at the next offer revision.
 */
it(
  "takes a Slack price request through the agent's read and proposal to the approved price",
  { timeout: 180_000 },
  offerPriceChangeJourney,
);

const CANONICAL_OFFER = commerceCanonicalResourceId(MERCHANT, OFFER);

async function offerPriceChangeJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  await givePortalHandles(ORGANISATION_ID);
  const owner = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "price",
  );
  const listedRevision = await listTheOffer();
  const allowance = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/offers/${encodeURIComponent(CANONICAL_OFFER)}/price-policy`,
    {
      method: "PUT",
      headers: mutationHeaders(owner),
      body: JSON.stringify({ expectedRevision: null, maxMovementBps: 2_000 }),
    },
  );
  expect(allowance.status, await allowance.clone().text()).toBe(200);
  const model = new PriceModel();
  const slack = slackSimulator();
  const answers: string[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    http.post(
      "https://hooks.slack.com/actions/:team/:id/:token",
      async function recordAnswer({ request }) {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Invalid click answer");
        answers.push(String(body.text));
        return HttpResponse.text("ok");
      },
    ),
  );

  // 1. The agent reads the price and the allowance, and proposes ¥2,600.
  await sendListingMessage(
    "app_mention",
    "EvPriceAsk",
    ROOT_TS,
    "<@U0PANTRY> Raise the cookie box to ¥2,600.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(2);
  const texts = slack.messages.map(textOf);
  expect(texts).toEqual([
    "*Change a listed price*\n2,400 JPY → 2,600 JPY (allowed range 1,920 JPY to 2,880 JPY)\n\nNothing changes until an owner or admin approves it.",
    "PRICE_AWAITING_APPROVAL",
  ]);
  expect(model.firstRead).toEqual({
    offerRevision: listedRevision,
    price: "2400 JPY",
    policy: "enabled",
    policyRevision: 1,
    range: "1920-2880",
  });
  expect(model.refusal).toContain("the request's reason breaks a rule");
  expect(model.refusal).not.toContain("Authoritative data is unavailable");
  expect(await shopPrice()).toEqual({
    priceMinor: 2_400,
    offerRevision: listedRevision,
  });

  // 2. The owner's click approves the change, and the shop charges ¥2,600.
  const nonce = listingNonce(model.requests);
  const card = slack.messages[0];
  const blocks: unknown = JSON.parse(card?.blocks ?? "[]");
  expect(blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "actions",
        elements: expect.arrayContaining([
          expect.objectContaining({
            action_id: "commerce_action_approve",
            value: nonce,
          }),
          expect.objectContaining({
            action_id: "commerce_action_decline",
            value: nonce,
          }),
        ]),
      }),
    ]),
  );
  const click = await exports.default.fetch(
    await signedButtonClick({
      actionId: "commerce_action_approve",
      value: nonce,
      user: USER_ID,
      channel: CHANNEL_ID,
      threadTs: ROOT_TS,
      proposalTs: card?.ts ?? "",
    }),
  );
  expect(click.status).toBe(200);
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(1);
  expect(answers[0]).toContain(`Approved by <@${USER_ID}>`);
  await expect
    .poll(shopPrice, { timeout: 30_000 })
    .toEqual({ priceMinor: 2_600, offerRevision: listedRevision + 1 });
  // The decision updates the one card: no new message, and no internal ids.
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
    .toContain("Purin Pantry made the change.");
  expect(slack.messages[0]?.text).toContain("2,400 JPY → 2,600 JPY");
  expect(slack.messages[0]?.text).not.toMatch(/receipt_|commerce:/u);
  expect(cardButtons(slack.messages[0])).toEqual(["commerce_action_details"]);
  expect(slack.visibleMessageCount()).toBe(2);

  // 3. The agent's next read in the thread shows the new price.
  await sendListingMessage(
    "message",
    "EvPriceAgain",
    "1787500000.000900",
    "<@U0PANTRY> What does the cookie box cost now?",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(3);
  expect(slack.messages.map(textOf).slice(2)).toEqual([
    "The cookie box costs 2600 JPY.",
  ]);
  expect(model.secondRead).toEqual({
    offerRevision: listedRevision + 1,
    price: "2600 JPY",
    policy: "enabled",
    policyRevision: 1,
    range: "1920-2880",
  });

  task.meta.slackOfferPriceChange = {
    substituted: [
      "model provider (deterministic OpenRouter transport)",
      "Slack (signed events, interaction payloads and response URLs)",
      "commerce provider (Commerce test merchant)",
    ],
    reads: [model.firstRead, model.secondRead],
    proposal: model.proposal,
    refusal: model.refusal,
    slackMessages: slack.messages.map(textOf),
    clickAnswers: answers,
    shop: await shopPrice(),
  };
}

type PriceRead = Readonly<{
  offerRevision: number;
  price: string;
  policy: string;
  policyRevision: number;
  range: string;
}>;

/**
 * Reads the offer, proposes the price from what the read showed, and reads
 * the offer again in the next turn. The proposal takes both revisions from
 * the read, so a read without them leaves nothing to propose.
 */
class PriceModel {
  readonly requests: Record<string, unknown>[] = [];
  firstRead: PriceRead | null = null;
  secondRead: PriceRead | null = null;
  proposal: Record<string, unknown> | null = null;
  refusal = "";

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Invalid price model request");
    this.requests.push(body);
    switch (this.requests.length) {
      case 1:
        return openRouterToolCall(
          "tool_search",
          { query: "commerce_entity_context", limit: 1 },
          "price_discover_read",
        );
      case 2:
        return openRouterToolCall(
          "tool_search",
          { query: "commerce_propose_action", limit: 1 },
          "price_discover_propose",
        );
      case 3:
        return openRouterToolCall(
          "codemode",
          { code: offerReadCode() },
          "price_read",
        );
      case 4: {
        this.firstRead = parsePriceRead(lastListingToolText(body));
        this.proposal = priceProposal(this.firstRead);
        return openRouterToolCall(
          "commerce_propose_action",
          {
            request: {
              ...this.proposal,
              reason: "The owner asked for ¥2,600.",
            },
          },
          "price_propose_with_reason",
        );
      }
      case 5:
        this.refusal = lastListingToolText(body);
        return openRouterToolCall(
          "commerce_propose_action",
          { request: this.proposal },
          "price_propose",
        );
      case 6:
        expect(lastListingToolText(body)).toContain("commerce_action_proposed");
        return openRouterText("PRICE_AWAITING_APPROVAL", "price_waiting");
      case 7:
        return openRouterToolCall(
          "codemode",
          { code: offerReadCode() },
          "price_read_again",
        );
      case 8:
        this.secondRead = parsePriceRead(lastListingToolText(body));
        return openRouterText(
          `The cookie box costs ${this.secondRead.price}.`,
          "price_now",
        );
      default:
        throw new Error("Unexpected price model request");
    }
  }
}

function offerReadCode(): string {
  const request = {
    selection: {
      kind: "entity_seeds",
      seeds: [{ origin: "system", typeId: "offer", entityId: OFFER }],
    },
    traversal: { maxDepth: 0, resultLimit: 1 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [
      "price",
      "price_policy",
      "price_policy_revision",
      "price_minimum",
      "price_maximum",
    ],
    freshnessRequirement: "current_only",
  };
  return `const read = await tools.commerce_entity_context({ request: ${JSON.stringify(request)} });
if (!read.ok) throw new Error(read.error.message);
const offer = read.result.entities[0];
const value = Object.fromEntries(offer.attributes.map((a) => [a.attributeId, a.value]));
const money = (id) => value[id] === undefined ? "none" : value[id].value.amountMinor + " " + value[id].value.currency;
text("offer_revision=" + offer.revision + "; price=" + money("price") + "; policy=" + (value.price_policy?.value ?? "none") + "; policy_revision=" + (value.price_policy_revision?.value ?? "none") + "; range=" + money("price_minimum").split(" ")[0] + "-" + money("price_maximum").split(" ")[0] + ";");`;
}

function parsePriceRead(output: string): PriceRead {
  const match = output.match(
    /offer_revision=(\d+); price=([^;]+); policy=([^;]+); policy_revision=([^;]+); range=([^;]+);/u,
  );
  if (match === null) throw new Error(`Price read missing: ${output}`);
  return {
    offerRevision: Number(match[1]),
    price: String(match[2]),
    policy: String(match[3]),
    policyRevision: Number(match[4]),
    range: String(match[5]),
  };
}

function priceProposal(read: PriceRead): Record<string, unknown> {
  return {
    kind: "adjust_offer_price",
    productId: null,
    productRevision: null,
    variantId: null,
    variantRevision: null,
    offerId: OFFER,
    offerRevision: null,
    expectedOfferRevision: read.offerRevision,
    expectedPolicyRevision: read.policyRevision,
    proposedPriceMinor: 2_600,
    currency: "JPY",
    salesChannelId: null,
    salesChannelRevision: null,
    resourceId: null,
    expectedRevision: null,
    reason: null,
    refund: null,
    restock: null,
    notifyCustomer: null,
    note: null,
    description: null,
    fulfillmentId: null,
    fulfillmentRevision: null,
    shipmentId: null,
    shipmentRevision: null,
    trackingNumber: null,
  };
}

/**
 * Lists the prepared cookie box in Commerce, and records the listed offer
 * in Pantry's projection as Commerce's delivery would.
 */
async function listTheOffer(): Promise<number> {
  const published = await providerClient().publishCatalogListing({
    merchantId: MERCHANT,
    idempotencyKey: "price-journey-publish",
    productId: PRODUCT,
    productRevision: 1,
    variantId: VARIANT,
    variantRevision: 1,
    offerId: OFFER,
    offerRevision: 1,
    salesChannelId: SALES_CHANNEL,
    salesChannelRevision: 1,
  });
  expect(published).toMatchObject({ ok: true, value: { outcome: "applied" } });
  const { offerRevision } = await shopPrice();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  await runInDurableObject(
    organisation,
    recordListedOffer.bind(undefined, offerRevision),
  );
  return offerRevision;
}

function recordListedOffer(
  revision: number,
  _actor: OrganisationDO,
  state: DurableObjectState,
): void {
  const occurredAt = new Date().toISOString();
  const offer: CommerceProjection = {
    kind: "offer",
    projection: {
      provenance: {
        ...listingProvenance("offer", OFFER, occurredAt),
        revision,
      },
      variantId: commerceCanonicalResourceId(MERCHANT, VARIANT),
      salesChannelId: commerceCanonicalResourceId(MERCHANT, SALES_CHANNEL),
      price: { amountMinor: 2400, currency: "JPY" },
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: occurredAt },
    },
  };
  state.storage.sql.exec(
    `UPDATE commerce_projection SET revision = ?, projection_json = ?
      WHERE organisation_id = ? AND projection_kind = 'offer' AND canonical_id = ?`,
    revision,
    JSON.stringify(offer),
    ORGANISATION_ID,
    CANONICAL_OFFER,
  );
}

/** The price and offer revision that Commerce holds now. */
async function shopPrice(): Promise<
  Readonly<{ priceMinor: number; offerRevision: number }>
> {
  const view = await providerClient().readOfferPricePolicy(MERCHANT, OFFER);
  const policy =
    view.ok && view.value.outcome === "accepted" ? view.value.value : null;
  if (
    !isRecord(policy) ||
    typeof policy.currentPriceMinor !== "number" ||
    typeof policy.currentOfferRevision !== "number"
  )
    throw new Error(JSON.stringify(view));
  return {
    priceMinor: policy.currentPriceMinor,
    offerRevision: policy.currentOfferRevision,
  };
}

function textOf(message: Record<string, string>): string {
  return message.text ?? "";
}
