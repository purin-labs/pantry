import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import {
  MENU_SCREEN_SOCKET_PROTOCOL,
  parseMenuBoardSummaries,
  parseMenuScreenFeed,
  parseMenuScreenPairing,
  parseMenuScreenPairingState,
  parseMenuScreenSummaries,
  type MenuScreenFeed,
} from "@purin-labs/cafe-control-api";
import { parseInventoryReceiptContext } from "@purin-labs/kitchen-control-api";
import { MenuBoardDoc, type MenuBoardUpdate } from "@purin-labs/menu-board-crdt";
import {
  encodeMenuBoardClientMessage,
  parseMenuBoardServerMessage,
} from "@purin-labs/menu-board-crdt/protocol";
import { MenuDraftDoc, type MenuDraftUpdate } from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
} from "@purin-labs/menu-draft-crdt/protocol";
import { isRecord } from "@purin-labs/std";
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";

import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { runScheduledCommerceOutboxReconciliation } from "../../src/commerce/outbox-worker";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import {
  PUBLIC_ORIGIN,
  closeSocket,
  controlReadHeaders,
  expectPong,
  nextCloseCode,
  openSocket,
} from "./hibernatable-socket-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";
import { applied, boardIdOf, nextSignal } from "./menu-board-journey-support";

declare module "vitest" {
  interface TaskMeta {
    menuBoardScreen?: Record<string, unknown>;
  }
}

const STOREFRONT = "storefront_cafe";
const MENU = "menu_cafe_main";
const DRINKS = ["Taro Milk Tea", "Ginger Milk Tea", "Matcha Tea"] as const;

it(
  "plays a published drinks board on a paired screen, marks a drink sold out on the screen and at checkout when staff count its last ingredient, and stops a removed screen",
  { timeout: 240_000 },
  menuBoardScreenJourney,
);

/**
 * Plan 40B phase 1, journey 1 ("Live board"). The owner publishes the café's
 * drinks menu. A member of staff makes a drinks board from the three-column
 * layout, changes it in the shared draft, and publishes it. A TV opens the
 * screen page, shows a code, and staff pair it with the board; a viewer may
 * not. The TV plays the board with live prices. Staff then count the taro
 * powder as gone: Commerce's event reaches Pantry, the TV gets a signal, its
 * next read shows Taro Milk Tea sold out, and the order page refuses it at
 * checkout. Last, staff remove the TV: its socket closes and its token stops.
 */
async function menuBoardScreenJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`board-owner-${crypto.randomUUID()}`);
  const staff = await commerceClient(`board-staff-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`board-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Board café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_board_cafe_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await fixtureDatabase().batch([
    ...member(organisationId, staff.identity.userId, "operator"),
    ...member(organisationId, viewer.identity.userId, "viewer"),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { operator: staff, privateMember: viewer },
  });
  const admin = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    }),
  );
  // The one-minute run subscribes Pantry to the merchant's webhooks.
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  const stock = await required(admin.readStockSnapshot(merchantId));
  const productIds = DRINKS.map((title) => {
    const product = stock.commerce.resources.products.find(
      (candidate) => candidate.title === title,
    );
    if (product === undefined) throw new Error(`No product ${title}`);
    return product.id;
  });
  const base = `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}`;

  // 1. The owner puts three drinks in a "Drinks" section and publishes them.
  const menuSocket = await openSocket(
    `${base}/collaboration/menu-draft/socket`,
    owner.session,
  );
  const menu = MenuDraftDoc.createReplica();
  try {
    const sync = await nextRoomMessage(
      menuSocket,
      parseMenuDraftServerMessage,
      "sync_response",
      () => {
        const vector = menu.stateVector();
        if (!vector.ok) throw new Error(vector.error.code);
        menuSocket.send(
          encodeMenuDraftClientMessage({
            kind: "sync_request",
            stateVector: vector.value,
          }),
        );
      },
    );
    if (sync.kind !== "sync_response") throw new Error("No menu sync");
    applied(menu.apply(sync.missingUpdate));
    await submitMenu(
      menuSocket,
      "drinks-section",
      menu.addSection({ id: "section_drinks", title: "Drinks", order: 1 }),
    );
    for (const [index, title] of DRINKS.entries())
      await submitMenu(
        menuSocket,
        `drink-${index}`,
        menu.addItem({
          id: itemId(title),
          productId: productIds[index] ?? "",
          displayName: title,
          description: "",
          placement: { sectionId: "section_drinks", order: index },
        }),
      );
  } finally {
    menu.destroy();
    await closeSocket(menuSocket);
  }
  const menuPublished = await send(
    `${base}/commerce/menu-publication`,
    owner.session,
    "POST",
    { documentRevision: await menuRevision(base, owner.session) },
  );
  expect(menuPublished.status, JSON.stringify(menuPublished.body)).toBe(200);

  // 1b. The owner names the shop, so its QR order page has its own address.
  //     Staff may not rename the shop, and a reserved name is refused.
  const staffName = await send(
    `${base}/commerce/shop-name`,
    staff.session,
    "PUT",
    {
      name: "nuki-board",
    },
  );
  expect(staffName.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const reserved = await send(
    `${base}/commerce/shop-name`,
    owner.session,
    "PUT",
    {
      name: "www",
    },
  );
  expect(reserved.status).toBe(422);
  expect(reserved.body).toMatchObject({ error: "shop_name_reserved" });
  const named = await send(`${base}/commerce/shop-name`, owner.session, "PUT", {
    name: "nuki-board",
  });
  expect(named.status, JSON.stringify(named.body)).toBe(200);
  expect(named.body).toMatchObject({
    shopName: { name: "nuki-board", suffix: ".menu.test" },
    shopUrl: "https://nuki-board.menu.test/",
  });

  // 2. Staff make a drinks board from the three-column layout. A viewer may
  //    see the boards but not make one.
  const viewerBoard = await send(
    `${base}/menu-boards`,
    viewer.session,
    "POST",
    {
      title: "Drinks",
      layout: "three_columns",
    },
  );
  expect(viewerBoard.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const created = await send(`${base}/menu-boards`, staff.session, "POST", {
    title: "Drinks",
    layout: "three_columns",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const boardId = boardIdOf(created.body);

  // 3. In the shared draft, staff drop the empty "Menu" section, move the
  //    drinks to the first column, and feature the taro milk tea.
  const boardSocket = await openSocket(
    `${base}/menu-boards/${boardId}/socket`,
    staff.session,
  );
  const board = MenuBoardDoc.createReplica();
  let boardRevision: number;
  try {
    const sync = await nextRoomMessage(
      boardSocket,
      parseMenuBoardServerMessage,
      "sync_response",
      () => {
        const vector = board.stateVector();
        if (!vector.ok) throw new Error(vector.error.code);
        boardSocket.send(
          encodeMenuBoardClientMessage({
            kind: "sync_request",
            stateVector: vector.value,
          }),
        );
      },
    );
    if (sync.kind !== "sync_response") throw new Error("No board sync");
    expect(sync.access).toBe("edit");
    applied(board.apply(sync.missingUpdate));
    const template = board.read();
    const emptySection = template.elements.find(
      (element) =>
        element.kind === "section" && element.sectionId === "section_main",
    );
    const drinks = template.elements.find(
      (element) =>
        element.kind === "section" && element.sectionId === "section_drinks",
    );
    const featured = template.elements.find(
      (element) => element.kind === "featured",
    );
    if (
      emptySection === undefined ||
      drinks === undefined ||
      featured === undefined
    )
      throw new Error(`Unexpected template: ${JSON.stringify(template)}`);
    await submitBoard(
      boardSocket,
      "drop-empty",
      board.removeElement(emptySection.id),
    );
    await submitBoard(
      boardSocket,
      "move-drinks",
      board.moveElement(drinks.id, { frameId: "column_1", order: 0 }),
    );
    await submitBoard(
      boardSocket,
      "feature-taro",
      board.updateElement(featured.id, {
        itemId: itemId("Taro Milk Tea"),
        note: "Nutty taro and Assam tea.",
      }),
    );
    boardRevision = sync.documentRevision + 3;
  } finally {
    board.destroy();
    await closeSocket(boardSocket);
  }

  // 4. Staff publish the revision they saw. The same click again answers the
  //    same release; a click on an older view is refused.
  const release = await send(
    `${base}/menu-boards/${boardId}/releases`,
    staff.session,
    "POST",
    { documentRevision: boardRevision, expectedReleaseRevision: null },
  );
  expect(release.status, JSON.stringify(release.body)).toBe(201);
  const replay = await send(
    `${base}/menu-boards/${boardId}/releases`,
    staff.session,
    "POST",
    { documentRevision: boardRevision, expectedReleaseRevision: null },
  );
  expect(replay.status).toBe(200);
  expect(releaseDigest(replay.body)).toBe(releaseDigest(release.body));
  const stale = await send(
    `${base}/menu-boards/${boardId}/releases`,
    staff.session,
    "POST",
    { documentRevision: boardRevision - 1, expectedReleaseRevision: 1 },
  );
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ error: "menu_board_changed" });

  // 5. A TV opens the screen page and shows its code. A viewer cannot pair
  //    it; staff pair it with the drinks board. Only the TV's own secret
  //    collects the token, and the code cannot pair a second screen.
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/pairings`,
    { method: "POST" },
  );
  expect(started.status).toBe(201);
  const pairing = parseMenuScreenPairing(await started.json());
  if (pairing === null) throw new Error("No pairing");
  expect(await pairingState(pairing.pairingId, pairing.secret)).toMatchObject({
    state: "waiting",
  });
  const pairBody = {
    code: pairing.code.toLowerCase(),
    name: "Counter TV",
    boardId,
  };
  const viewerPair = await send(
    `${base}/menu-screens`,
    viewer.session,
    "POST",
    pairBody,
  );
  expect(viewerPair.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const paired = await send(
    `${base}/menu-screens`,
    staff.session,
    "POST",
    pairBody,
  );
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  expect(
    (await pairingResponse(pairing.pairingId, "x".repeat(43))).status,
  ).toBe(401);
  const collected = await pairingState(pairing.pairingId, pairing.secret);
  if (collected?.state !== "paired") throw new Error("Screen not paired");
  const token = collected.token;
  const second = await send(`${base}/menu-screens`, staff.session, "POST", {
    ...pairBody,
    name: "Second TV",
  });
  expect(second.status).toBe(409);
  expect(second.body).toMatchObject({ error: "menu_screen_code_used" });

  //    One client cannot hold the codes of every shop: an address holds at
  //    most 50 open codes, the hosts of one IPv6 /64 count as one address,
  //    and another address still gets a code.
  for (let index = 0; index < 50; index += 1) {
    const host =
      index % 2 === 0 ? "2001:db8:40b:1::7" : "2001:db8:40b:1:ffff::9";
    expect((await askPairing(host)).status).toBe(201);
  }
  const limited = await askPairing("2001:0DB8:040b:0001::1");
  expect(limited.status).toBe(429);
  expect(limited.body).toMatchObject({ error: "menu_screen_pairing_limit" });
  const otherAddress = await askPairing("203.0.113.7");
  expect(otherAddress.status).toBe(201);

  // 6. The TV plays the board: the drinks in the first column with the
  //    shop's prices, the taro milk tea featured, and the order page's link.
  const playing = await screenFeed(token);
  expect(playing.status).toBe(200);
  const first = requireFeed(playing.feed);
  if (first.release === null) throw new Error("No release on the screen");
  expect(first.screen.name).toBe("Counter TV");
  expect(first.release.digest).toBe(releaseDigest(release.body));
  expect(first.release.elements).toContainEqual(
    expect.objectContaining({
      kind: "section",
      sectionId: "section_drinks",
      placement: { frameId: "column_1", order: 0 },
    }),
  );
  expect(first.release.elements).not.toContainEqual(
    expect.objectContaining({ kind: "section", sectionId: "section_main" }),
  );
  expect(first.release.sections).toEqual([
    {
      sectionId: "section_drinks",
      title: "Drinks",
      itemIds: DRINKS.map(itemId),
    },
  ]);
  // The board's QR code opens the shop's order page under its new name.
  expect(first.facts?.orderUrl).toBe("https://nuki-board.menu.test/");
  expect(availability(first, "Taro Milk Tea")).toEqual({
    availability: "available",
    price: { amountMinor: 700, currency: "JPY" },
  });

  // 7. The TV keeps its signal socket open; the Screens list shows it live.
  const screenSocket = await openScreenSocket(token);
  await expectPong(screenSocket);
  const screens = await send(`${base}/menu-screens`, owner.session, "GET");
  const listed = parseMenuScreenSummaries(
    isRecord(screens.body) ? screens.body.screens : null,
  );
  expect(listed).toEqual([
    expect.objectContaining({ name: "Counter TV", boardId, connected: true }),
  ]);
  const boards = await send(`${base}/menu-boards`, viewer.session, "GET");
  expect(
    parseMenuBoardSummaries(isRecord(boards.body) ? boards.body.boards : null),
  ).toEqual([
    expect.objectContaining({
      boardId,
      screens: 1,
      release: expect.objectContaining({ releaseRevision: 1 }),
    }),
  ]);

  // 8. Staff count the taro powder as gone. The TV gets a signal from
  //    Commerce's event alone, and its next read shows the drink sold out.
  const signalled = nextSignal(screenSocket);
  const countedAt = Date.now();
  await countToZero(organisationId, merchantId, staff.session, admin);
  const signalAfterMs = (await signalled) - countedAt;
  let soldOut: MenuScreenFeed | null = null;
  await expect
    .poll(
      async () => {
        const read = await screenFeed(token);
        soldOut = read.feed;
        return read.feed === null
          ? null
          : availability(read.feed, "Taro Milk Tea")?.availability;
      },
      { timeout: 20_000, interval: 500 },
    )
    .toBe("unavailable");
  const soldOutAfterMs = Date.now() - countedAt;
  expect(availability(requireFeed(soldOut), "Ginger Milk Tea")).toMatchObject({
    availability: "available",
  });

  // 9. The order page refuses the drink in its cart, and still takes a
  //    drink that needs no taro.
  const refusal = await cartRefusal(merchantId, itemId("Taro Milk Tea"));
  expect(refusal).toMatchObject({ error: { field: "cart.lines.menu" } });
  expect(await cartRefusal(merchantId, itemId("Ginger Milk Tea"))).toBeNull();

  // 10. Staff remove the TV: its socket closes as removed, and its token
  //     stops, so the player goes back to pairing.
  const screenId = listed?.[0]?.screenId ?? "";
  const closed = nextCloseCode(screenSocket);
  const removed = await send(
    `${base}/menu-screens/${screenId}`,
    staff.session,
    "DELETE",
  );
  expect(removed.status).toBe(200);
  expect(await closed).toBe(4403);
  expect((await screenFeed(token)).status).toBe(401);
  expect((await openScreenSocketResponse(token)).status).toBe(401);

  task.meta.menuBoardScreen = {
    board: { boardId, layout: "three_columns", draftEdits: 3 },
    release: {
      releaseRevision: 1,
      digest: first.release.digest,
      replayStatus: replay.status,
      staleStatus: stale.status,
    },
    pairing: {
      viewerRefusal: "organisation_role_insufficient",
      staffStatus: paired.status,
      wrongSecretStatus: 401,
      reusedCodeStatus: second.status,
      addressLimit: {
        openCodes: 50,
        refusedStatus: limited.status,
        otherAddressStatus: otherAddress.status,
      },
    },
    liveFacts: {
      before: DRINKS.map((title) => ({
        title,
        ...availability(first, title),
      })),
      after: DRINKS.map((title) => ({
        title,
        ...availability(requireFeed(soldOut), title),
      })),
      signalAfterMs,
      soldOutOnScreenAfterMs: soldOutAfterMs,
      cartRefusal: refusal,
    },
    removal: { closeCode: 4403, feedStatus: 401, socketStatus: 401 },
  };
}

function itemId(title: string): string {
  return `item_${title.toLowerCase().replaceAll(" ", "_")}`;
}

function member(
  organisationId: string,
  userId: string,
  role: "operator" | "viewer",
): D1PreparedStatement[] {
  const personId = `person_board_${role}`;
  return [
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, role),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
      )
      .bind(organisationId, userId, personId, role, Date.now()),
  ];
}

async function send(
  url: string,
  session: IssuedControlSession,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers =
    method === "GET"
      ? new Headers(controlReadHeaders(session))
      : commerceHeaders(session);
  if (method !== "GET") {
    headers.set("idempotency-key", crypto.randomUUID());
    headers.set("x-satyr-configuration-version", "1");
  }
  const response = await exports.default.fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function menuRevision(
  base: string,
  session: IssuedControlSession,
): Promise<number> {
  const read = await send(`${base}/collaboration/menu-draft`, session, "GET");
  if (
    !isRecord(read.body) ||
    !isRecord(read.body.value) ||
    typeof read.body.value.revision !== "number"
  )
    throw new Error(`No draft revision: ${JSON.stringify(read.body)}`);
  return read.body.value.revision;
}

function releaseDigest(body: unknown): string {
  if (
    !isRecord(body) ||
    !isRecord(body.release) ||
    typeof body.release.digest !== "string"
  )
    throw new Error(`No release: ${JSON.stringify(body)}`);
  return body.release.digest;
}

async function askPairing(
  address: string,
): Promise<{ status: number; body: unknown }> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/pairings`,
    { method: "POST", headers: { "CF-Connecting-IP": address } },
  );
  return { status: response.status, body: await response.json() };
}

function pairingResponse(pairingId: string, secret: string): Promise<Response> {
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/pairings/${pairingId}`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
}

async function pairingState(pairingId: string, secret: string) {
  const response = await pairingResponse(pairingId, secret);
  expect(response.status).toBe(200);
  return parseMenuScreenPairingState(await response.json());
}

async function screenFeed(
  token: string,
): Promise<Readonly<{ status: number; feed: MenuScreenFeed | null }>> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/feed`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body: unknown = await response.json();
  return { status: response.status, feed: parseMenuScreenFeed(body) };
}

function requireFeed(feed: MenuScreenFeed | null): MenuScreenFeed {
  if (feed === null) throw new Error("The screen feed did not parse");
  return feed;
}

function availability(feed: MenuScreenFeed, title: string) {
  const entry = feed.facts?.entries.find(
    (candidate) => candidate.menuEntryId === itemId(title),
  );
  return entry === undefined
    ? undefined
    : { availability: entry.availability, price: entry.price };
}

function openScreenSocketResponse(token: string): Promise<Response> {
  return exports.default.fetch(`${PUBLIC_ORIGIN}/v1/screens/socket`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `${MENU_SCREEN_SOCKET_PROTOCOL}, ${token}`,
    },
  });
}

async function openScreenSocket(token: string): Promise<WebSocket> {
  const response = await openScreenSocketResponse(token);
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
    MENU_SCREEN_SOCKET_PROTOCOL,
  );
  if (response.webSocket === null) throw new Error("No screen socket");
  response.webSocket.accept();
  return response.webSocket;
}

/** Staff count each lot of the café's taro powder as empty. */
async function countToZero(
  organisationId: string,
  merchantId: string,
  session: IssuedControlSession,
  admin: CommerceAdminClient,
): Promise<void> {
  const commerce = `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce`;
  const storefront = await required(
    admin.readStorefront(merchantId, STOREFRONT),
  );
  if (storefront.fulfillment.kind !== "pickup")
    throw new Error("The café sells for pickup");
  const locationId = storefront.fulfillment.locationId;
  const stock = await required(admin.readStockSnapshot(merchantId));
  const position = stock.commerce.resources.inventoryPositions.find(
    (candidate) =>
      candidate.inventoryItemId === "inventory_taro_powder" &&
      candidate.locationId === locationId,
  );
  if (position === undefined) throw new Error("No taro powder at the café");
  for (let pass = 0; pass < 10; pass += 1) {
    const context = parseInventoryReceiptContext(
      (
        await send(
          `${commerce}/inventory/receipts?position=${position.id}`,
          session,
          "GET",
        )
      ).body,
    );
    const lot = context.lots.find((candidate) => candidate.quantity.amount > 0);
    if (context.lots.length > 0 && lot === undefined) return;
    const counted = await send(
      `${commerce}/inventory/reconciliations`,
      session,
      "POST",
      {
        merchantRevision: context.merchantRevision,
        inventoryPositionId: context.inventoryPositionId,
        inventoryPositionRevision: context.inventoryPositionRevision,
        target:
          lot === undefined
            ? { kind: "aggregate" }
            : { kind: "lot", lotId: lot.id, lotRevision: lot.revision },
        change: {
          kind: "count",
          observedQuantity: { amount: 0, scale: 0, unit: context.unit },
          explanation: "The taro powder ran out",
        },
        requestedAt: new Date().toISOString(),
      },
    );
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    if (lot === undefined) return;
  }
  throw new Error("The taro powder count did not finish");
}

/**
 * The order page's cart for one menu entry: the refusal that Commerce
 * answers, or null when it takes the line. The journey stops at the cart, so
 * that it leaves no quoted checkout that holds stock.
 */
async function cartRefusal(
  merchantId: string,
  menuEntryId: string,
): Promise<unknown> {
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://underclerk.test",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  const session = await required(
    buyer.createSession(merchantId, STOREFRONT, {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  const cart = await buyer.createCart(merchantId, STOREFRONT, session.token, {
    schemaVersion: "underclerk.create-buyer-cart.v1",
    idempotencyKey: `cart-${crypto.randomUUID()}`,
    lines: [
      {
        kind: "menu",
        menuId: MENU,
        menuEntryId,
        modifierOptionIds: [],
        quantity: 1,
      },
    ],
  });
  return cart.ok ? null : cart.error;
}

async function submitMenu(
  socket: WebSocket,
  updateId: string,
  result:
    | Readonly<{ ok: true; value: MenuDraftUpdate }>
    | Readonly<{ ok: false; error: { code: string } }>,
): Promise<void> {
  if (!result.ok) throw new Error(result.error.code);
  const update = result.value;
  const accepted = await nextRoomMessage(
    socket,
    parseMenuDraftServerMessage,
    "update_accepted",
    () =>
      socket.send(
        encodeMenuDraftClientMessage({
          kind: "submit_update",
          updateId,
          update,
        }),
      ),
  );
  expect(accepted).toMatchObject({ kind: "update_accepted", updateId });
}

async function submitBoard(
  socket: WebSocket,
  updateId: string,
  result:
    | Readonly<{ ok: true; value: MenuBoardUpdate }>
    | Readonly<{ ok: false; error: { code: string } }>,
): Promise<void> {
  if (!result.ok) throw new Error(result.error.code);
  const update = result.value;
  const accepted = await nextRoomMessage(
    socket,
    parseMenuBoardServerMessage,
    "update_accepted",
    () =>
      socket.send(
        encodeMenuBoardClientMessage({
          kind: "submit_update",
          updateId,
          update,
        }),
      ),
  );
  expect(accepted).toMatchObject({ kind: "update_accepted", updateId });
}

type RoomMessage = Readonly<{ kind: string }>;

function nextRoomMessage<M extends RoomMessage>(
  socket: WebSocket,
  parse: (
    frame: unknown,
  ) =>
    Readonly<{ ok: true; value: M }> | Readonly<{ ok: false; error: unknown }>,
  kind: M["kind"],
  send: () => void,
): Promise<M> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`No ${kind} message`));
    }, 10_000);
    const onMessage = (event: MessageEvent): void => {
      const parsed = parse(event.data);
      if (!parsed.ok) return;
      const message = parsed.value;
      if (message.kind === "failure") {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        reject(new Error(`Room failure: ${JSON.stringify(message)}`));
        return;
      }
      if (message.kind !== kind) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
    send();
  });
}

async function required<T>(
  result: Promise<
    Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>
  >,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  return resolved.value;
}
