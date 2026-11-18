// Plan 40B phase 4: Sous Chef works on the shop's menu boards. In a Slack thread the
// agent puts an item on the menu draft; the owner publishes the menu and a
// board, and pairs a TV. The agent then reads the boards with their live
// prices, changes the board's featured label in the room that people edit (a
// stale edit is refused), and proposes a deal on the item. Nothing changes on
// the TV before an owner approves. The approval card shows the price before
// and after; an operator's click on it is refused and changes nothing. The
// owner's click sets the deal in Commerce, and the TV shows the new price
// with the earlier price struck through, with no new board release. The
// board's text change reaches the TV only when a person publishes the board.
import { fixtureDatabase } from "./organisation-database";
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  parseMenuScreenFeed,
  parseMenuScreenPairing,
  parseMenuScreenPairingState,
  type MenuScreenFeed,
} from "@seams/control-api";
import { isRecord } from "@seams/std";
import { commerceActionTitle } from "../../../../apps/portal/src/features/governed-actions/commerce";
import { parseCommerceActionRecordResponse } from "@seams/control-api/portal/commerce-actions";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { enableCapability } from "./access-route-support";
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
import { signedButtonClick } from "./slack-side-case-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  cardButtons,
  createRequiredGrant,
  discoverSlackChannel,
  installSlackActorFixture,
  isApprovalCard,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardAgent?: Record<string, unknown>;
  }
}

const ORIGIN = "https://localhost";
const BASE = `${ORIGIN}/v1/control/organisations/${ORGANISATION_ID}`;
const SECTION = "section_main";
const ITEM = "Taro Milk Tea";
const FEATURED_LABEL = "Today’s pick";
const NEW_LABEL = "Deal of the day";

type Script = {
  taroProductId: string;
  itemId: string;
  boardId: string;
  featuredId: string;
  outputs: string[];
};

type Answer = Readonly<{
  ephemeral: boolean;
  replaceOriginal: boolean;
  text: string;
}>;

it(
  "lets Urk change a board and propose a deal that reaches the TV only after an owner approves its before-and-after card",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const fixture = await installSlackActorFixture();
    const slack = slackSimulator();
    const requests: Record<string, unknown>[] = [];
    const answers: Answer[] = [];
    const script: Script = {
      taroProductId: "",
      itemId: "",
      boardId: "",
      featuredId: "",
      outputs: [],
    };
    network.use(
      slack.handler,
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        respond.bind(null, requests, script),
      ),
      http.post(
        "https://hooks.slack.com/actions/:team/:id/:token",
        async function recordAnswer({ request }) {
          const body: unknown = await request.json();
          if (!isRecord(body)) throw new Error("Invalid click answer");
          answers.push({
            ephemeral: body.response_type === "ephemeral",
            replaceOriginal: body.replace_original === true,
            text: String(body.text),
          });
          return HttpResponse.text("ok");
        },
      ),
    );
    const owner = await installEffectAuthority(
      fixture.selectedIntegrationAccountId,
      "plugin",
    );
    await givePortalHandles(ORGANISATION_ID);
    await discoverSlackChannel("public_channel", Date.now() - 60_000);
    for (const capabilityId of [
      "commerce.menu_draft.read",
      "commerce.menu_draft.edit",
    ] as const) {
      await enableCapability(ORGANISATION_ID, owner, capabilityId);
      await createRequiredGrant({
        grantId: `grant_board_${capabilityId.replaceAll(".", "_")}`,
        subject: { kind: "organisation_role", role: "owner" },
        target: {
          kind: "platform_capability",
          capabilityId,
          capabilityVersion: 1,
        },
        now: Date.now(),
      });
    }
    const shop = await providerClient().provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: ORGANISATION_ID,
      merchantId: MERCHANT,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    });
    if (!shop.ok) throw new Error(JSON.stringify(shop.error));
    const taro = shop.value.resources.products.find(
      (product) => product.title === ITEM,
    );
    if (taro === undefined) throw new Error(`No product ${ITEM}`);
    script.taroProductId = taro.id;

    // Turn 1: the agent puts the item on the menu draft.
    await sendListingMessage(
      "app_mention",
      "EvBoardItem",
      ROOT_TS,
      "<@U0SATYR> Put the taro milk tea on the menu.",
    );
    await expect
      .poll(delivered.bind(null, slack), { timeout: 30_000 })
      .toContain("PB_ITEM_IN_DRAFT");

    // The owner publishes the menu and a two-column board from it, and pairs
    // a TV with the board.
    const menuPublished = await send(
      `${BASE}/commerce/menu-publication`,
      owner,
      "POST",
      { documentRevision: await menuRevision(owner) },
    );
    expect(menuPublished.status, JSON.stringify(menuPublished.body)).toBe(200);
    const created = await send(`${BASE}/menu-boards`, owner, "POST", {
      title: "Drinks",
      layout: "two_columns",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    script.boardId = boardIdOf(created.body);
    const firstRelease = await publishBoard(owner, script.boardId, null);
    const token = await pairScreen(owner, script.boardId);
    const before = await feed(token);
    expect(entryOf(before, script.itemId)).toMatchObject({
      price: { amountMinor: 700, currency: "JPY" },
      compareAtPrice: null,
      availability: "available",
    });
    expect(featuredLabel(before)).toBe(FEATURED_LABEL);

    // Turn 2: the agent reads the boards, renames the featured card, and
    // proposes a deal. A stale text and a deal that is not lower are refused
    // in words that it can act on.
    await sendListingMessage(
      "message",
      "EvBoardDeal",
      "1710000200.000100",
      "Call the featured card Deal of the day, and propose a deal: taro milk tea at ¥600.",
      ROOT_TS,
    );
    await expect
      .poll(delivered.bind(null, slack), { timeout: 30_000 })
      .toContain("PB_DEAL_WAITING");
    const card = slack.messages.find(isApprovalCard);
    if (card === undefined) throw new Error("No approval card");
    expect(card.text).toContain(`Deal on ${ITEM}`);
    expect(card.text).toContain("700 JPY → 600 JPY (was 700 JPY)");
    expect(cardButtons(card)).toEqual(
      expect.arrayContaining([
        "commerce_action_approve",
        "commerce_action_decline",
      ]),
    );
    const nonce = listingNonce(requests);

    // The Portal's own parser reads the record that the approval signs.
    const record = parseCommerceActionRecordResponse(
      await (
        await exports.default.fetch(`${BASE}/commerce/actions/${nonce}`, {
          headers: readHeaders(owner),
        })
      ).json(),
    );
    expect(commerceActionTitle(record.verb)).toBe("Change a menu price");
    expect(record.details).toMatchObject({
      kind: "change_menu_price",
      menuEntryId: script.itemId,
      itemName: ITEM,
      before: {
        price: { amountMinor: 700, currency: "JPY" },
        compareAtPrice: null,
      },
      after: {
        price: { amountMinor: 600, currency: "JPY" },
        compareAtPrice: { amountMinor: 700, currency: "JPY" },
      },
    });

    // Nothing changed yet: the TV keeps the price and the published label,
    // and an execution before the approval is refused.
    const early = await postControl(owner, `/${nonce}/execute`, {}, "pb-early");
    expect(early.status).toBe(409);
    const waiting = await feed(token);
    expect(entryOf(waiting, script.itemId)?.price.amountMinor).toBe(700);
    expect(featuredLabel(waiting)).toBe(FEATURED_LABEL);
    expect(waiting.release?.releaseRevision).toBe(firstRelease);

    // An operator's click is refused to that member only, and nothing moves.
    await setRole("operator");
    await click(nonce, card.ts ?? "");
    await expect.poll(() => answers.length, { timeout: 15_000 }).toBe(1);
    expect(answers[0]).toMatchObject({ ephemeral: true });
    expect(answers[0]?.text).toContain("Only an owner or admin");
    expect(await actionState(nonce)).toBe("proposed");
    expect((await offer(script.itemId)).price.amountMinor).toBe(700);

    // The owner's click sets the deal. The TV shows it with no new release.
    await setRole("owner");
    await click(nonce, card.ts ?? "");
    await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(2);
    expect(answers[1]).toMatchObject({ replaceOriginal: true });
    expect(answers[1]?.text).toContain("Seams Pantry made the change.");
    expect(await actionState(nonce)).toBe("confirmed");
    expect(await offer(script.itemId)).toMatchObject({
      price: { amountMinor: 600, currency: "JPY" },
      compareAtPrice: { amountMinor: 700, currency: "JPY" },
    });
    await expect
      .poll(
        async () =>
          entryOf(await feed(token), script.itemId)?.price.amountMinor,
        { timeout: 15_000, interval: 500 },
      )
      .toBe(600);
    const dealt = await feed(token);
    expect(entryOf(dealt, script.itemId)).toMatchObject({
      compareAtPrice: { amountMinor: 700, currency: "JPY" },
    });
    expect(dealt.release?.releaseRevision).toBe(firstRelease);
    expect(featuredLabel(dealt)).toBe(FEATURED_LABEL);

    // The same click again changes nothing a second time.
    const offerRevision = (await offer(script.itemId)).revision;
    await click(nonce, card.ts ?? "");
    await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(3);
    expect((await offer(script.itemId)).revision).toBe(offerRevision);

    // The owner publishes the board: the TV shows the agent's label.
    const boards = await send(`${BASE}/menu-boards`, owner, "GET");
    const secondRelease = await publishBoard(
      owner,
      script.boardId,
      firstRelease,
    );
    const published = await feed(token);
    expect(published.release?.releaseRevision).toBe(secondRelease);
    expect(featuredLabel(published)).toBe(NEW_LABEL);
    expect(entryOf(published, script.itemId)?.price.amountMinor).toBe(600);

    task.meta.menuBoardAgent = {
      substituted: [
        "model provider (deterministic OpenRouter transport)",
        "Slack (signed events, interaction payloads and response URLs)",
      ],
      real: ["Satyr Worker", "Underclerk fixture Worker", "screen feed"],
      toolOutputs: script.outputs,
      card: { text: card.text, buttons: cardButtons(card) },
      record: record.details,
      clickAnswers: answers,
      screen: {
        before: entryOf(before, script.itemId),
        waiting: entryOf(waiting, script.itemId),
        afterApproval: entryOf(dealt, script.itemId),
        releases: [firstRelease, secondRelease],
        labelAfterPublish: featuredLabel(published),
      },
      boards: boards.body,
    };
  },
);

async function respond(
  requests: Record<string, unknown>[],
  script: Script,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid board model request");
  requests.push(body);
  const step = requests.length;
  const last = toolOutput(body);
  if (last.length > 0) script.outputs.push(last);
  switch (step) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "menu_draft_edit", limit: 1 },
        "pb_discover_draft",
      );
    case 2:
      return openRouterToolCall(
        "menu_draft_edit",
        {
          kind: "add_item",
          itemId: null,
          sectionId: SECTION,
          productId: script.taroProductId,
          title: ITEM,
          description: "Nutty taro and Assam tea.",
          order: null,
        },
        "pb_add_item",
      );
    case 3:
      script.itemId = draftItemId(last, ITEM);
      return openRouterText("PB_ITEM_IN_DRAFT", "pb_item_done");
    case 4:
      return openRouterToolCall(
        "tool_search",
        {
          query: "menu_board_read menu_board_edit menu_board_propose_price",
          limit: 3,
        },
        "pb_discover_boards",
      );
    case 5:
      return openRouterToolCall(
        "menu_board_read",
        { boardId: null },
        "pb_read_boards",
      );
    case 6: {
      const read = boardRead(last);
      expect(read.items).toContainEqual(
        expect.objectContaining({
          itemId: script.itemId,
          name: ITEM,
          price: { amountMinor: 700, currency: "JPY" },
          wasPrice: null,
        }),
      );
      const featured = read.featured;
      expect(featured.label).toBe(FEATURED_LABEL);
      script.featuredId = featured.id;
      // The agent starts from a text that is not on the board now.
      return openRouterToolCall(
        "menu_board_edit",
        boardEdit(script, { before: "Pick of the week" }),
        "pb_edit_stale",
      );
    }
    case 7:
      expect(last).toContain("Someone changed that text");
      expect(last).toContain(FEATURED_LABEL);
      return openRouterToolCall(
        "menu_board_edit",
        boardEdit(script, { before: FEATURED_LABEL }),
        "pb_edit",
      );
    case 8: {
      const edited: unknown = JSON.parse(last);
      expect(edited).toMatchObject({
        boardId: script.boardId,
        change: {
          elementId: script.featuredId,
          before: { kind: "featured", label: FEATURED_LABEL },
          after: { kind: "featured", label: NEW_LABEL },
        },
      });
      // A deal must be lower than the price that it replaces.
      return openRouterToolCall(
        "menu_board_propose_price",
        { itemId: script.itemId, priceMinor: 800, deal: true },
        "pb_deal_higher",
      );
    }
    case 9:
      expect(last).toContain("A deal price must be lower");
      return openRouterToolCall(
        "menu_board_propose_price",
        { itemId: script.itemId, priceMinor: 600, deal: true },
        "pb_deal",
      );
    case 10:
      expect(last).toContain("commerce_action_proposed");
      return openRouterText("PB_DEAL_WAITING", "pb_deal_waiting");
    default:
      throw new Error(`Unexpected board model request ${step}`);
  }
}

function boardEdit(
  script: Script,
  fields: Readonly<{ before: string }>,
): Record<string, unknown> {
  return {
    kind: "set_text",
    boardId: script.boardId,
    elementId: script.featuredId,
    prop: "label",
    before: fields.before,
    text: NEW_LABEL,
    title: null,
    itemId: null,
    frameId: null,
    order: null,
    x: null,
    y: null,
    width: null,
    height: null,
  };
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

function draftItemId(toolText: string, displayName: string): string {
  const parsed: unknown = JSON.parse(toolText);
  const items =
    isRecord(parsed) &&
    isRecord(parsed.draft) &&
    Array.isArray(parsed.draft.items)
      ? (parsed.draft.items as unknown[])
      : [];
  for (const item of items)
    if (
      isRecord(item) &&
      item.displayName === displayName &&
      typeof item.id === "string"
    )
      return item.id;
  throw new Error(`No item ${displayName} in ${toolText}`);
}

function boardRead(toolText: string): Readonly<{
  items: readonly unknown[];
  featured: Readonly<{ id: string; label: string }>;
}> {
  const parsed: unknown = JSON.parse(toolText);
  if (!isRecord(parsed) || !Array.isArray(parsed.boards))
    throw new Error(`No boards in ${toolText}`);
  const board: unknown = parsed.boards[0];
  const elements =
    isRecord(board) && Array.isArray(board.elements) ? board.elements : [];
  const featured: unknown = elements.find(
    (element: unknown) => isRecord(element) && element.kind === "featured",
  );
  if (
    !isRecord(featured) ||
    typeof featured.id !== "string" ||
    typeof featured.label !== "string"
  )
    throw new Error(`No featured element in ${toolText}`);
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    featured: { id: featured.id, label: featured.label },
  };
}

function delivered(slack: ReturnType<typeof slackSimulator>): string {
  return slack.messages.map((message) => message.text).join("\n");
}

function readHeaders(session: IssuedControlSession): Record<string, string> {
  return {
    origin: ORIGIN,
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
  };
}

async function send(
  url: string,
  session: IssuedControlSession,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers: Record<string, string> = readHeaders(session);
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = crypto.randomUUID();
    headers["x-satyr-configuration-version"] = "1";
  }
  const response = await exports.default.fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function menuRevision(session: IssuedControlSession): Promise<number> {
  const read = await send(`${BASE}/collaboration/menu-draft`, session, "GET");
  if (
    !isRecord(read.body) ||
    !isRecord(read.body.value) ||
    typeof read.body.value.revision !== "number"
  )
    throw new Error(`No draft revision: ${JSON.stringify(read.body)}`);
  return read.body.value.revision;
}

function boardIdOf(body: unknown): string {
  if (
    !isRecord(body) ||
    !isRecord(body.board) ||
    typeof body.board.boardId !== "string"
  )
    throw new Error(`No board: ${JSON.stringify(body)}`);
  return body.board.boardId;
}

/** Publishes the board's current draft revision; answers the release revision. */
async function publishBoard(
  session: IssuedControlSession,
  boardId: string,
  expectedReleaseRevision: number | null,
): Promise<number> {
  const list = await send(`${BASE}/menu-boards`, session, "GET");
  const boards =
    isRecord(list.body) && Array.isArray(list.body.boards)
      ? list.body.boards
      : [];
  const board: unknown = boards.find(
    (candidate: unknown) =>
      isRecord(candidate) && candidate.boardId === boardId,
  );
  if (!isRecord(board) || typeof board.documentRevision !== "number")
    throw new Error(`No board ${boardId}: ${JSON.stringify(list.body)}`);
  const release = await send(
    `${BASE}/menu-boards/${boardId}/releases`,
    session,
    "POST",
    { documentRevision: board.documentRevision, expectedReleaseRevision },
  );
  expect(release.status, JSON.stringify(release.body)).toBe(201);
  if (
    !isRecord(release.body) ||
    !isRecord(release.body.release) ||
    typeof release.body.release.releaseRevision !== "number"
  )
    throw new Error(`No release: ${JSON.stringify(release.body)}`);
  return release.body.release.releaseRevision;
}

/** A TV shows its code; the owner pairs it; the TV collects its token. */
async function pairScreen(
  session: IssuedControlSession,
  boardId: string,
): Promise<string> {
  const started = await exports.default.fetch(`${ORIGIN}/v1/screens/pairings`, {
    method: "POST",
  });
  expect(started.status).toBe(201);
  const pairing = parseMenuScreenPairing(await started.json());
  if (pairing === null) throw new Error("No pairing");
  const paired = await send(`${BASE}/menu-screens`, session, "POST", {
    code: pairing.code,
    name: "Counter TV",
    boardId,
  });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  const state = await exports.default.fetch(
    `${ORIGIN}/v1/screens/pairings/${pairing.pairingId}`,
    { headers: { Authorization: `Bearer ${pairing.secret}` } },
  );
  const collected = parseMenuScreenPairingState(await state.json());
  if (collected?.state !== "paired") throw new Error("Screen not paired");
  return collected.token;
}

async function feed(token: string): Promise<MenuScreenFeed> {
  const response = await exports.default.fetch(`${ORIGIN}/v1/screens/feed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const parsed = parseMenuScreenFeed(await response.json());
  if (parsed === null) throw new Error("The screen feed did not parse");
  return parsed;
}

function entryOf(screen: MenuScreenFeed, itemId: string) {
  return screen.facts?.entries.find(
    (candidate) => candidate.menuEntryId === itemId,
  );
}

function featuredLabel(screen: MenuScreenFeed): string | undefined {
  const element = screen.release?.elements.find(
    (candidate) => candidate.kind === "featured",
  );
  return element?.kind === "featured" ? element.label : undefined;
}

async function offer(itemId: string) {
  const stock = await providerClient().readStockSnapshot(MERCHANT);
  if (!stock.ok) throw new Error(JSON.stringify(stock.error));
  const entry = stock.value.foodService.resources.menus
    .flatMap((menu) => menu.entries)
    .find((candidate) => candidate.menuEntryId === itemId);
  const found = stock.value.commerce.resources.offers.find(
    (candidate) => candidate.id === entry?.offerId,
  );
  if (found === undefined) throw new Error(`No offer for ${itemId}`);
  return found;
}

async function click(nonce: string, noticeTs: string): Promise<void> {
  const response = await exports.default.fetch(
    await signedButtonClick({
      actionId: "commerce_action_approve",
      value: nonce,
      user: USER_ID,
      channel: CHANNEL_ID,
      threadTs: ROOT_TS,
      proposalTs: noticeTs,
    }),
  );
  expect(response.status).toBe(200);
}

async function setRole(role: "owner" | "operator"): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(role, ORGANISATION_ID, OWNER)
    .run();
}

async function actionState(nonce: string): Promise<unknown> {
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
