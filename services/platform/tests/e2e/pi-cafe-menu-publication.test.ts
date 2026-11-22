// Plan 81 slice 4: an agent edits the shared menu draft in the room that
// people use, and proposes its publication. Nothing goes live before an owner
// approves with a step-up sign-in; then Commerce serves exactly the approved
// menu, one time. A draft edit after the proposal stays in the draft. A
// proposal for a stale draft revision and one with an item that the café
// cannot sell are refused in words that the agent can act on. An approved
// publication that the shop has since overtaken is refused at commit and
// leaves the live menu alone. An agent's publication keeps the serving hours
// that a person set.
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import { commerceActionTitle } from "../../../../apps/portal/src/features/governed-actions/commerce";
import {
  parseCommerceActionRecordResponse,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { googleConfig } from "@purin-labs/control/worker/google-oidc-config";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { enableCapability, mutationHeaders } from "./access-route-support";
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
  createRequiredGrant,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";

const BASE = `https://localhost/v1/control/organisations/${ORGANISATION_ID}`;
const MENU_ID = "menu_cafe_main";
const SECTION = "section_main";
const LATER_THREAD = "1710000200.000100";

const SERVING_HOURS = {
  timeZone: "UTC",
  slots: [
    {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      startsAt: "00:00",
      endsAt: "23:59",
    },
  ],
};

type Script = {
  cookieId: string;
  latteId: string;
  cookieItemId: string;
  notSoldItemId: string;
  draftRevision: number;
};

function edit(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    itemId: null,
    sectionId: null,
    productId: null,
    title: null,
    description: null,
    order: null,
    ...fields,
  };
}

it("publishes an agent's menu only after an owner approves that exact menu", async ({
  task,
}) => {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  const script: Script = {
    cookieId: "",
    latteId: "",
    cookieItemId: "",
    notSoldItemId: "",
    draftRevision: 0,
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
  await enableCapability(ORGANISATION_ID, session, "commerce.menu_draft.edit");
  await createRequiredGrant({
    grantId: "grant_pi_menu_edit",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: "commerce.menu_draft.edit",
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
  const shop = await providerClient().provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!shop.ok) throw new Error(JSON.stringify(shop.error));
  script.cookieId = productNamed(shop.value, "Taro Milk Tea");
  script.latteId = productNamed(shop.value, "Ginger Milk Tea");
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "cafe-menu-publication",
      requests,
      delivered: slack.messages,
    },
  });
  const liveBefore = await liveMenu();

  // Turn 1: the agent edits the draft. Two proposals are refused in words it
  // can act on; the third waits for approval.
  await sendListingMessage(
    "app_mention",
    "EvPiMenuFirst",
    ROOT_TS,
    "<@U0PANTRY> Call the menu Autumn menu, put the sesame cookie on it and set it up to publish.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 20_000 }).toBe(2);
  const draft = await readDraft(session);
  expect(draft.draft.title).toBe("Autumn menu");
  expect(draft.draft.items.map((item) => item.displayName)).toEqual([
    "Sesame cookie",
  ]);
  expect(slack.messages.map((message) => message.text).join("\n")).toContain(
    'Publish the menu "Autumn menu"',
  );
  expect(await liveMenu()).toEqual(liveBefore);
  const firstNonce = listingNonce(requests);

  // The owner's card reads the record that the approval signs, by the Portal's
  // own parser: the exact menu, by name, with what is new.
  const card = parseCommerceActionRecordResponse(
    await (
      await exports.default.fetch(`${BASE}/commerce/actions/${firstNonce}`, {
        headers: mutationHeaders(session),
      })
    ).json(),
  );
  expect(commerceActionTitle(card.verb)).toBe("Publish café menu");
  if (card.details.kind !== "publish_cafe_menu")
    throw new Error(`Unexpected card ${card.details.kind}`);
  expect(card.details.menu.name).toBe("Autumn menu");
  expect(card.details.entryNames).toEqual([
    { menuEntryId: script.cookieItemId, displayName: "Sesame cookie" },
  ]);
  expect(card.details.addedEntryIds).toEqual([script.cookieItemId]);

  // The approval comes later, so execution before it changes nothing.
  const early = await postControl(
    session,
    `/${firstNonce}/execute`,
    {},
    "pi-menu-early",
  );
  expect(early.status).toBe(409);
  expect(await liveMenu()).toEqual(liveBefore);

  // Turn 2: a later draft edit from another thread, while the approval waits.
  await sendListingMessage(
    "app_mention",
    "EvPiMenuLater",
    LATER_THREAD,
    "<@U0PANTRY> Add the ginger milk tea to the menu too.",
    LATER_THREAD,
  );
  await expect
    .poll(delivered.bind(null, slack), { timeout: 20_000 })
    .toContain("PI_MENU_LATTE_IN_DRAFT");
  expect(
    (await readDraft(session)).draft.items.map((item) => item.displayName),
  ).toEqual(["Sesame cookie", "Hojicha latte"]);

  // The owner approves the first proposal: the live menu is what they saw.
  const result = await approveAndExecute(session, firstNonce, "first");
  expect(result).toMatchObject({
    ok: true,
    action: { state: "confirmed" },
    receipt: { resourceId: MENU_ID, projectionKind: "cafe_menu" },
  });
  const live = await liveMenu();
  if (live === undefined) throw new Error("The menu did not go live");
  expect(live.name).toBe("Autumn menu");
  expect(live.entries.map((entry) => entry.menuEntryId)).toEqual([
    script.cookieItemId,
  ]);
  const replayed = await postControl(
    session,
    `/${firstNonce}/execute`,
    {},
    "pi-menu-first-execute",
  );
  expect(await replayed.json()).toEqual(result);
  expect((await liveMenu())?.revision).toBe(live.revision);

  // Turn 3: the agent proposes the newer draft, but the owner publishes from
  // the Menus page first. The approved action is refused at commit.
  await sendListingMessage(
    "message",
    "EvPiMenuSecond",
    "1710000300.000100",
    "Set up the ginger milk tea for publishing as well.",
    LATER_THREAD,
  );
  await expect
    .poll(delivered.bind(null, slack), { timeout: 20_000 })
    .toContain("PI_MENU_SECOND_WAITING");
  const secondNonce = listingNonce(requests);
  expect(secondNonce).not.toBe(firstNonce);
  const person = await exports.default.fetch(
    `${BASE}/commerce/menu-publication`,
    {
      method: "POST",
      headers: mutationHeaders(session),
      body: JSON.stringify({
        documentRevision: (await readDraft(session)).revision,
        hours: SERVING_HOURS,
      }),
    },
  );
  expect(person.status, await person.clone().text()).toBe(200);
  const afterPerson = await liveMenu();
  expect(afterPerson?.revision).toBe(live.revision + 1);
  expect(afterPerson?.entries.length).toBe(2);
  const overtaken = await approveAndExecute(session, secondNonce, "second", {
    expectedStatus: 502,
  });
  expect(overtaken).toMatchObject({ ok: false });
  expect((await liveMenu())?.revision).toBe(live.revision + 1);

  // Turn 4: the agent proposes again. The owner's serving hours stay.
  await sendListingMessage(
    "message",
    "EvPiMenuThird",
    "1710000400.000100",
    "Set the menu up to publish again.",
    LATER_THREAD,
  );
  await expect
    .poll(delivered.bind(null, slack), { timeout: 20_000 })
    .toContain("PI_MENU_THIRD_WAITING");
  const thirdNonce = listingNonce(requests);
  expect(thirdNonce).not.toBe(secondNonce);
  await approveAndExecute(session, thirdNonce, "third");
  const afterAgent = await liveMenu();
  expect(afterAgent?.revision).toBe(live.revision + 2);
  expect(afterAgent?.validity).toEqual({ kind: "schedule", ...SERVING_HOURS });
}, 120_000);

// A private channel is private content (Plan 27C): the edit asks a person and
// the shared menu stays as it is.
it("asks a person before content of a private channel enters the shared menu", async () => {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  const outputs: string[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondPrivate.bind(null, outputs),
    ),
  );
  const session = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "plugin",
  );
  await givePortalHandles(ORGANISATION_ID);
  await enableCapability(ORGANISATION_ID, session, "commerce.menu_draft.edit");
  await createRequiredGrant({
    grantId: "grant_pi_menu_edit",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: "commerce.menu_draft.edit",
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
  await sendListingMessage(
    "app_mention",
    "EvPiMenuPrivate",
    ROOT_TS,
    "<@U0PANTRY> Call the menu Secret menu.",
  );
  await expect
    .poll(delivered.bind(null, slack), { timeout: 20_000 })
    .toContain("PI_MENU_ASKED");
  expect(outputs.join("\n")).toContain("Purin Pantry stopped this step");
  const response = await exports.default.fetch(
    `${BASE}/collaboration/menu-draft`,
    { headers: mutationHeaders(session) },
  );
  // No edit ran, so the Organisation still has no draft to read.
  expect(await response.text()).not.toContain("Secret menu");
}, 60_000);

async function respondPrivate(
  outputs: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid menu model request");
  const last = toolOutput(body);
  outputs.push(last);
  switch (outputs.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "menu_draft_edit", limit: 1 },
        "pi_menu_private_discover",
      );
    case 2:
      return openRouterToolCall(
        "menu_draft_edit",
        edit({ kind: "rename_menu", title: "Secret menu" }),
        "pi_menu_private_edit",
      );
    default:
      return openRouterText("PI_MENU_ASKED", "pi_menu_private_asked");
  }
}

function productNamed(
  shop: Readonly<{
    resources: Readonly<{
      products: readonly Readonly<{ id: string; title: string }>[];
    }>;
  }>,
  title: string,
): string {
  const product = shop.resources.products.find(
    (candidate) => candidate.title === title,
  );
  if (product === undefined) throw new Error(`No product ${title}`);
  return product.id;
}

function delivered(slack: ReturnType<typeof slackSimulator>): string {
  return slack.messages.map((message) => message.text).join("\n");
}

async function readDraft(session: IssuedControlSession) {
  const response = await exports.default.fetch(
    `${BASE}/collaboration/menu-draft`,
    { headers: mutationHeaders(session) },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    value: {
      revision: number;
      draft: { title: string; items: { id: string; displayName: string }[] };
    };
  };
  return body.value;
}

async function liveMenu() {
  const stock = await providerClient().readStockSnapshot(MERCHANT);
  if (!stock.ok) throw new Error(JSON.stringify(stock.error));
  return stock.value.foodService.resources.menus.find(
    (menu) => menu.menuId === MENU_ID,
  );
}

async function approveAndExecute(
  session: IssuedControlSession,
  nonce: string,
  name: string,
  options: Readonly<{ expectedStatus: number }> = { expectedStatus: 200 },
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
    stepUpId: `pi-menu-${name}-step-up`,
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    `pi-menu-${name}-approve`,
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const executed = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    `pi-menu-${name}-execute`,
  );
  expect(executed.status, await executed.clone().text()).toBe(
    options.expectedStatus,
  );
  return executed.json();
}

function revisionIn(toolText: string): number {
  const match = toolText.match(/"revision":(\d+)/u);
  if (match?.[1] === undefined) throw new Error(`No revision in ${toolText}`);
  return Number(match[1]);
}

function itemIdNamed(toolText: string, displayName: string): string {
  const parsed: unknown = JSON.parse(toolText);
  const items =
    isRecord(parsed) && isRecord(parsed.draft) && Array.isArray(parsed.draft.items)
      ? (parsed.draft.items as unknown[])
      : [];
  for (const item of items) {
    if (
      isRecord(item) &&
      item.displayName === displayName &&
      typeof item.id === "string"
    )
      return item.id;
  }
  throw new Error(`No item ${displayName} in ${toolText}`);
}

/** The text that the tool returned, without the model request's wrapper. */
function toolOutput(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.some((item) => isRecord(item) && item.role === "tool"))
    return "";
  const wrapped: unknown = JSON.parse(lastListingToolText(body));
  return isRecord(wrapped) && typeof wrapped.output === "string"
    ? wrapped.output
    : JSON.stringify(wrapped);
}

async function respond(
  requests: Record<string, unknown>[],
  script: Script,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid menu model request");
  requests.push(body);
  const step = requests.length;
  const last = toolOutput(body);
  switch (step) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "menu_draft_edit commerce_propose_menu_publication", limit: 2 },
        "pi_menu_discover",
      );
    case 2:
      return openRouterToolCall(
        "menu_draft_edit",
        edit({ kind: "rename_menu", title: "Autumn menu" }),
        "pi_menu_rename",
      );
    case 3:
      return openRouterToolCall(
        "menu_draft_edit",
        edit({
          kind: "add_item",
          productId: script.cookieId,
          title: "Sesame cookie",
          description: "Baked this morning.",
          sectionId: SECTION,
        }),
        "pi_menu_add_cookie",
      );
    case 4:
      script.cookieItemId = itemIdNamed(last, "Sesame cookie");
      return openRouterToolCall(
        "menu_draft_edit",
        edit({
          kind: "add_item",
          productId: "product_not_sold_here",
          title: "Not sold here",
          description: "",
          sectionId: SECTION,
        }),
        "pi_menu_add_not_sold",
      );
    case 5:
      script.notSoldItemId = itemIdNamed(last, "Not sold here");
      // One revision behind what the last edit returned.
      return openRouterToolCall(
        "commerce_propose_menu_publication",
        { documentRevision: revisionIn(last) - 1 },
        "pi_menu_propose_stale",
      );
    case 6: {
      expect(last).toContain("The menu changed since that read");
      const current = last.match(/at revision (\d+)/u)?.[1];
      return openRouterToolCall(
        "commerce_propose_menu_publication",
        { documentRevision: Number(current) },
        "pi_menu_propose_not_sold",
      );
    }
    case 7:
      expect(last).toContain("The café cannot sell these items now");
      expect(last).toContain("Not sold here");
      return openRouterToolCall(
        "menu_draft_edit",
        edit({ kind: "remove_item", itemId: script.notSoldItemId }),
        "pi_menu_remove",
      );
    case 8:
      return openRouterToolCall(
        "commerce_propose_menu_publication",
        { documentRevision: revisionIn(last) },
        "pi_menu_propose",
      );
    case 9:
      expect(last).toContain("commerce_action_proposed");
      return openRouterText("PI_MENU_AWAITING_APPROVAL", "pi_menu_waiting");
    case 10:
      // The later thread is a new Session, with its own discovery.
      return openRouterToolCall(
        "tool_search",
        { query: "menu_draft_edit commerce_propose_menu_publication", limit: 2 },
        "pi_menu_discover_later",
      );
    case 11:
      return openRouterToolCall(
        "menu_draft_edit",
        edit({
          kind: "add_item",
          productId: script.latteId,
          title: "Hojicha latte",
          description: "",
          sectionId: SECTION,
        }),
        "pi_menu_add_latte",
      );
    case 12:
      return openRouterText("PI_MENU_LATTE_IN_DRAFT", "pi_menu_later");
    case 13:
      script.draftRevision = revisionIn(last);
      return openRouterToolCall(
        "commerce_propose_menu_publication",
        { documentRevision: script.draftRevision },
        "pi_menu_propose_second",
      );
    case 14:
      expect(last).toContain("commerce_action_proposed");
      return openRouterText("PI_MENU_SECOND_WAITING", "pi_menu_second");
    case 15:
      return openRouterToolCall(
        "commerce_propose_menu_publication",
        { documentRevision: script.draftRevision },
        "pi_menu_propose_third",
      );
    case 16:
      expect(last).toContain("commerce_action_proposed");
      return openRouterText("PI_MENU_THIRD_WAITING", "pi_menu_third");
    default:
      throw new Error(`Unexpected menu model request ${step}`);
  }
}
