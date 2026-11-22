// Plan 81 slice 5: the agent proposes a new product description. The catalogue
// keeps the old text until an owner approves the exact new text.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { googleConfig } from "@purin-labs/control/worker/google-oidc-config";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  MERCHANT,
  OWNER,
  PRODUCT,
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

const NEW_TEXT = "Six cookies, baked each morning with sesame from Kagoshima.";

it("changes a product description only after an owner approves the exact text", async () => {
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
    "price",
  );
  await givePortalHandles(ORGANISATION_ID);
  await discoverSlackChannel("public_channel", Date.now() - 60_000);
  const before = await description();
  await sendListingMessage(
    "app_mention",
    "EvPiDescription",
    ROOT_TS,
    "<@U0PANTRY> Update the cookie box description.",
  );
  await expect
    .poll(() => slack.messages.map((message) => message.text).join("\n"), {
      timeout: 20_000,
    })
    .toContain("PI_DESCRIPTION_WAITING");
  const nonce = listingNonce(requests);
  expect(await description()).toBe(before);
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
    stepUpId: "pi-description-step-up",
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    "pi-description-approve",
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const executed = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "pi-description-execute",
  );
  expect(executed.status, await executed.clone().text()).toBe(200);
  expect(await description()).toBe(NEW_TEXT);
}, 120_000);

async function description(): Promise<string> {
  const snapshot = await providerClient().readSnapshot(MERCHANT);
  if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.error));
  const product = snapshot.value.resources.products.find(
    (candidate) => candidate.id === PRODUCT,
  );
  if (product === undefined) throw new Error("No product");
  return product.description;
}

async function respond(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid description model request");
  requests.push(body);
  switch (requests.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "commerce_entity_context", limit: 1 },
        "pi_description_discover_read",
      );
    case 2:
      return openRouterToolCall(
        "tool_search",
        { query: "commerce_propose_action", limit: 1 },
        "pi_description_discover",
      );
    case 3:
      return openRouterToolCall(
        "codemode",
        {
          code: `const graph = await tools.commerce_entity_context({ request: ${JSON.stringify(
            {
              selection: {
                kind: "entity_seeds",
                seeds: [
                  { origin: "system", typeId: "product", entityId: PRODUCT },
                ],
              },
              traversal: { maxDepth: 0, resultLimit: 1 },
              allowedSensitivity: "internal",
              allowedAttributeIds: [],
              freshnessRequirement: "current_only",
            },
          )} });\nif (!graph.ok) throw new Error(graph.error.message);\ntext("read");`,
        },
        "pi_description_read",
      );
    case 4:
      return openRouterToolCall(
        "commerce_propose_action",
        {
          request: {
            kind: "update_product_description",
            productId: PRODUCT,
            productRevision: 1,
            variantId: null,
            variantRevision: null,
            offerId: null,
            offerRevision: null,
            expectedOfferRevision: null,
            expectedPolicyRevision: null,
            proposedPriceMinor: null,
            currency: null,
            salesChannelId: null,
            salesChannelRevision: null,
            resourceId: null,
            expectedRevision: null,
            reason: null,
            refund: null,
            restock: null,
            notifyCustomer: null,
            note: null,
            description: NEW_TEXT,
            fulfillmentId: null,
            fulfillmentRevision: null,
            shipmentId: null,
            shipmentRevision: null,
            trackingNumber: null,
          },
        },
        "pi_description_propose",
      );
    case 5:
      return openRouterText("PI_DESCRIPTION_WAITING", "pi_description_waiting");
    default:
      throw new Error(`Unexpected model request ${requests.length}`);
  }
}
