import { env, exports } from "cloudflare:workers";
import { organisationDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import {
  MENU_SCREEN_SOCKET_PROTOCOL,
  parseMenuScreenFeed,
  parseMenuScreenPairing,
  parseMenuScreenPairingState,
} from "@purin-labs/cafe-control-api";
import {
  parseMenuScreenPickup,
  parseBankPayouts,
  parseFailedPaymentsDay,
  parseOrderTimes,
  parseOrderQueueEntries,
  parsePaymentsDay,
  parseSoldOutItems,
  type MenuScreenPickup,
  type OrderQueueEntry,
} from "@purin-labs/control-api";
import { MenuDraftDoc, type MenuDraftUpdate } from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
} from "@purin-labs/menu-draft-crdt/protocol";
import { isRecord } from "@purin-labs/std";
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  commercePickupCode,
  type CommerceBuyerCartLineV1,
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
  openSocket,
} from "./hibernatable-socket-support";
import { boardIdOf, nextSignal } from "./menu-board-journey-support";

declare module "vitest" {
  interface TaskMeta {
    orderQueue?: Record<string, unknown>;
    failedPayments?: Record<string, unknown>;
  }
}

const STOREFRONT = "storefront_cafe";
const MENU = "menu_cafe_main";
const TARO = "item_taro";
const COOKIE = "item_taro_cookie";
const BUYER_EMAIL = "buyer-private@example.test";
const TARO_LINE: CommerceBuyerCartLineV1 = {
  kind: "menu",
  menuId: MENU,
  menuEntryId: TARO,
  modifierOptionIds: [],
  quantity: 1,
};

it(
  "takes a QR order through the staff queue and the pickup board: a made-to-order drink and a cookie appear, a sale in the middle costs nothing, an early hand-over and a second tablet are refused, and a viewer sees nothing",
  { timeout: 240_000 },
  orderQueueJourney,
);

it(
  "takes an item off sale from the queue page and a menu off sale outside its hours: the screen, the QR order page and checkout all follow",
  { timeout: 240_000 },
  soldOutAndHoursJourney,
);

it(
  "shows staff a declined QR payment and the retry that paid it, with no buyer named: a viewer cannot read the list",
  { timeout: 240_000 },
  failedPaymentsJourney,
);

/**
 * Plan 40B phase 3. The milk runs out. Staff mark the taro milk tea as sold out
 * from the queue page: the paired screen hears it at once and shows it, and the
 * QR order page refuses it, with no change to the stock count. A viewer cannot
 * do this. Staff put it back. The owner then gives the menu serving hours: the
 * screen and the order page have no menu outside them, and they return when
 * the owner widens the hours. A later publish with no hours keeps them.
 */
async function soldOutAndHoursJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`hours-owner-${crypto.randomUUID()}`);
  const staff = await commerceClient(`hours-staff-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`hours-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Hours café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_hours_cafe_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await organisationDatabase(organisationId).batch([
    ...member(organisationId, staff.identity.userId, "operator"),
    ...member(organisationId, viewer.identity.userId, "viewer"),
  ]);
  const admin = new CommerceAdminClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    }),
  );
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  const base = `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}`;
  const soldOutPath = `${base}/commerce/sold-out`;
  await publishMenu(base, owner.session, admin, merchantId);

  const created = await send(`${base}/menu-boards`, staff.session, "POST", {
    title: "Drinks",
    layout: "three_columns",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const boardId = boardIdOf(created.body);
  const release = await send(
    `${base}/menu-boards/${boardId}/releases`,
    staff.session,
    "POST",
    {
      documentRevision: await boardRevision(base, staff.session, boardId),
      expectedReleaseRevision: null,
    },
  );
  expect(release.status, JSON.stringify(release.body)).toBe(201);
  const token = await pairedScreen(base, staff.session, boardId);
  const socket = await openScreenSocket(token);

  const screenAvailability = async (): Promise<Record<string, string>> => {
    const feed = parseMenuScreenFeed(await (await screenRead("feed", token)).json());
    if (feed === null) throw new Error("The screen feed did not parse");
    return Object.fromEntries(
      (feed.facts?.entries ?? []).map((entry) => [
        entry.menuEntryId,
        entry.availability,
      ]),
    );
  };
  // Plan 40B's target: a screen shows a change within 5 seconds.
  const screenShows = (wanted: Record<string, string>): Promise<void> =>
    expect
      .poll(screenAvailability, { timeout: 5_000, interval: 250 })
      .toEqual(wanted);
  const waitPastSnapshot = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 2_500));
  const items = async (session: IssuedControlSession) => {
    const read = await send(soldOutPath, session, "GET");
    const parsed = parseSoldOutItems(isRecord(read.body) ? read.body.items : null);
    if (parsed === null) throw new Error(JSON.stringify(read.body));
    return parsed;
  };
  const tryBuy = async (key: string): Promise<string> =>
    placeOrder(merchantId, key, TARO_LINE).then(
      () => "paid",
      (error: unknown) => String(error),
    );

  expect(await screenAvailability()).toEqual({
    [TARO]: "available",
    [COOKIE]: "available",
  });
  const before = await items(staff.session);
  const taro = before.find((item) => item.title === "Taro Milk Tea");
  if (taro === undefined) throw new Error("No taro item");
  expect(taro.soldOutUntil).toBeNull();

  // A viewer cannot mark an item, and an item off the menu is refused.
  const viewerMark = await send(
    `${soldOutPath}/${taro.variantId}`,
    viewer.session,
    "POST",
    { soldOut: true, timeZone: "Asia/Tokyo" },
  );
  expect(viewerMark.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const offMenu = await send(
    `${soldOutPath}/variant_nothing`,
    staff.session,
    "POST",
    { soldOut: true, timeZone: "Asia/Tokyo" },
  );
  expect(offMenu.status).toBe(404);

  // Staff mark it. The screen hears it, and the order page refuses it.
  const stockBefore = await required(admin.readStockSnapshot(merchantId));
  const signal = nextSignal(socket);
  const mark = await send(
    `${soldOutPath}/${taro.variantId}`,
    staff.session,
    "POST",
    { soldOut: true, timeZone: "Asia/Tokyo" },
  );
  expect(mark.status, JSON.stringify(mark.body)).toBe(200);
  await signal;
  await screenShows({ [TARO]: "unavailable", [COOKIE]: "available" });
  const refusedSoldOut = await tryBuy("sold-out");
  expect(refusedSoldOut).not.toBe("paid");
  const stockAfter = await required(admin.readStockSnapshot(merchantId));
  expect(stockAfter.commerce.resources.inventoryPositions).toEqual(
    stockBefore.commerce.resources.inventoryPositions,
  );
  const markedUntil = (await items(staff.session)).find(
    (item) => item.variantId === taro.variantId,
  )?.soldOutUntil;
  expect(Date.parse(markedUntil ?? "")).toBeGreaterThan(Date.now());
  expect(Date.parse(markedUntil ?? "")).toBeLessThanOrEqual(
    Date.now() + 24 * 3_600_000,
  );

  // Staff put it back, and a customer pays.
  const cleared = await send(
    `${soldOutPath}/${taro.variantId}`,
    staff.session,
    "POST",
    { soldOut: false },
  );
  expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  await screenShows({ [TARO]: "available", [COOKIE]: "available" });
  expect(await tryBuy("back-on-sale")).toBe("paid");
  await closeSocket(socket);

  // The owner's hours exclude this moment, whenever the journey runs.
  const hour = new Date().getUTCHours();
  const elsewhere = hour < 12 ? "13" : "01";
  const closedHours = {
    timeZone: "UTC",
    slots: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        startsAt: `${elsewhere}:00`,
        endsAt: `${elsewhere}:59`,
      },
    ],
  };
  const documentRevision = await draftRevision(base, owner.session);
  const publication = `${base}/commerce/menu-publication`;
  const staffHours = await send(publication, staff.session, "POST", {
    documentRevision,
    hours: closedHours,
  });
  expect(staffHours.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const refusedHours = await send(publication, owner.session, "POST", {
    documentRevision,
    hours: {
      timeZone: "UTC",
      slots: [{ days: ["mon"], startsAt: "22:00", endsAt: "02:00" }],
    },
  });
  expect(refusedHours.status).toBe(409);
  expect(refusedHours.body).toMatchObject({ error: "menu_hours_invalid" });
  const closed = await send(publication, owner.session, "POST", {
    documentRevision,
    hours: closedHours,
  });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  await screenShows({});
  const refusedClosed = await tryBuy("closed");
  expect(refusedClosed).not.toBe("paid");

  // A publish that does not name hours keeps them.
  const kept = await send(publication, owner.session, "POST", {
    documentRevision,
  });
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  await waitPastSnapshot();
  expect(await screenAvailability()).toEqual({});
  const options = await send(publication, owner.session, "GET");
  expect(options.body).toMatchObject({ hours: closedHours });

  // The owner widens the hours, and the menu returns.
  const open = await send(publication, owner.session, "POST", {
    documentRevision,
    hours: {
      timeZone: "UTC",
      slots: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          startsAt: "00:00",
          endsAt: "24:00",
        },
      ],
    },
  });
  expect(open.status, JSON.stringify(open.body)).toBe(200);
  await screenShows({ [TARO]: "available", [COOKIE]: "available" });
  expect(await tryBuy("open-again")).toBe("paid");
  const allDay = await send(publication, owner.session, "POST", {
    documentRevision,
    hours: null,
  });
  expect(allDay.status, JSON.stringify(allDay.body)).toBe(200);
  const allDayOptions = await send(publication, owner.session, "GET");
  expect(allDayOptions.body).toMatchObject({ hours: null });

  task.meta.orderQueue = {
    refusals: {
      viewerMark: "organisation_role_insufficient",
      offMenu: offMenu.status,
      staffHours: "organisation_role_insufficient",
      invalidHours: "menu_hours_invalid",
    },
    soldOutBuyerPaid: refusedSoldOut === "paid",
    closedBuyerPaid: refusedClosed === "paid",
  };
}

async function draftRevision(
  base: string,
  session: IssuedControlSession,
): Promise<number> {
  const draft = await send(`${base}/collaboration/menu-draft`, session, "GET");
  if (
    !isRecord(draft.body) ||
    !isRecord(draft.body.value) ||
    typeof draft.body.value.revision !== "number"
  )
    throw new Error(`No draft revision: ${JSON.stringify(draft.body)}`);
  return draft.body.value.revision;
}

/**
 * Plan 40B phase 3, journey 3 ("Pickup"). A customer scans the QR code and
 * pays for a taro milk tea, which staff make to order, and another pays for a
 * sesame cookie from the case. Both codes show under "Preparing" on the pickup
 * board, with no name. Staff work through them in the queue, one action each,
 * while another customer pays: the code moves to "Ready", and it leaves the
 * board when staff hand the order over.
 */
async function orderQueueJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`queue-owner-${crypto.randomUUID()}`);
  const staff = await commerceClient(`queue-staff-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`queue-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Queue café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_queue_cafe_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await organisationDatabase(organisationId).batch([
    ...member(organisationId, staff.identity.userId, "operator"),
    ...member(organisationId, viewer.identity.userId, "viewer"),
  ]);
  const admin = new CommerceAdminClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    }),
  );
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  const base = `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}`;
  const queuePath = `${base}/commerce/order-queue`;

  // 1. The owner publishes a taro milk tea, which staff make to order, and a
  //    taro cookie from the case.
  await publishMenu(base, owner.session, admin, merchantId);

  // 2. Staff make a pickup board, publish it, and pair a TV with it.
  const created = await send(`${base}/menu-boards`, staff.session, "POST", {
    title: "Pickup",
    layout: "pickup_board",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const boardId = boardIdOf(created.body);
  const release = await send(
    `${base}/menu-boards/${boardId}/releases`,
    staff.session,
    "POST",
    {
      documentRevision: await boardRevision(base, staff.session, boardId),
      expectedReleaseRevision: null,
    },
  );
  expect(release.status, JSON.stringify(release.body)).toBe(201);
  const token = await pairedScreen(base, staff.session, boardId);
  const feed = parseMenuScreenFeed(
    await (await screenRead("feed", token)).json(),
  );
  expect(
    feed?.release?.elements.filter(
      (element) => element.kind === "pickup_codes",
    ),
  ).toEqual([
    expect.objectContaining({ stage: "preparing", title: "Preparing" }),
    expect.objectContaining({ stage: "ready", title: "Ready" }),
  ]);
  expect(await boardCodes(token)).toMatchObject({ preparing: [], ready: [] });
  const socket = await openScreenSocket(token);
  await expectPong(socket);

  // 3. Two customers pay. The board shows both codes with no signal lost.
  const signalled = nextSignal(socket);
  const paidAt = Date.now();
  const taro = await placeOrder(merchantId, "taro", {
    kind: "menu",
    menuId: MENU,
    menuEntryId: TARO,
    modifierOptionIds: [],
    quantity: 1,
  });
  const signalAfterMs = (await signalled) - paidAt;
  const cookie = await placeOrder(merchantId, "cookie", {
    kind: "menu",
    menuId: MENU,
    menuEntryId: COOKIE,
    modifierOptionIds: [],
    quantity: 2,
  });
  const taroCode = commercePickupCode(taro.orderId);
  const cookieCode = commercePickupCode(cookie.orderId);
  await waitForBoard(token, { preparing: [taroCode, cookieCode], ready: [] });

  // 4. A viewer sees no queue, and neither the queue nor the board names a
  //    buyer. Staff see what to make, oldest first.
  const refused = await send(queuePath, viewer.session, "GET");
  expect(refused.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const listed = await send(queuePath, staff.session, "GET");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(JSON.stringify(listed.body)).not.toContain(BUYER_EMAIL);
  const entries = entriesOf(listed.body);
  expect(entries.map((entry) => entry.code)).toEqual([taroCode, cookieCode]);
  const taroEntry = entryFor(entries, taroCode);
  const cookieEntry = entryFor(entries, cookieCode);
  expect(taroEntry).toMatchObject({
    channel: "online",
    stage: "preparing",
    preparation: "not_started",
    lines: [expect.objectContaining({ quantity: 1 })],
  });
  expect(cookieEntry).toMatchObject({
    preparation: "not_needed",
    lines: [expect.objectContaining({ quantity: 2 })],
  });

  // 5. Staff may not hand over an order before it is ready.
  const early = await advance(
    queuePath,
    staff.session,
    taroEntry.fulfillmentId,
    "hand_over",
  );
  expect(early.status).toBe(409);
  expect(early.body).toMatchObject({ error: "order_queue_changed" });

  // 6. A viewer may not move an order. Staff start the drink; its code stays
  //    under "Preparing". The same click again changes nothing.
  const viewerMove = await advance(
    queuePath,
    viewer.session,
    taroEntry.fulfillmentId,
    "start",
  );
  expect(viewerMove.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const repeatedKey = crypto.randomUUID();
  const started = await advance(
    queuePath,
    staff.session,
    taroEntry.fulfillmentId,
    "start",
    repeatedKey,
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const repeated = await advance(
    queuePath,
    staff.session,
    taroEntry.fulfillmentId,
    "start",
    repeatedKey,
  );
  expect(repeated.status).toBe(200);
  expect(
    entryFor(await readQueue(queuePath, staff.session), taroCode).preparation,
  ).toBe("preparing");

  // 7. Staff mark the drink ready while a third customer pays. The sale moves
  //    the merchant's revision, and the staff action still lands.
  const [ready, third] = await Promise.all([
    advance(queuePath, staff.session, taroEntry.fulfillmentId, "ready"),
    placeOrder(merchantId, "third", {
      kind: "menu",
      menuId: MENU,
      menuEntryId: COOKIE,
      modifierOptionIds: [],
      quantity: 1,
    }),
  ]);
  expect(ready.status, JSON.stringify(ready.body)).toBe(200);
  const thirdCode = commercePickupCode(third.orderId);
  await waitForBoard(token, {
    preparing: [cookieCode, thirdCode],
    ready: [taroCode],
  });

  // 8. The cookie needs no making: one action marks it ready.
  const cookieReady = await advance(
    queuePath,
    staff.session,
    cookieEntry.fulfillmentId,
    "ready",
  );
  expect(cookieReady.status, JSON.stringify(cookieReady.body)).toBe(200);

  // 9. Staff hand the drink over. It leaves the queue and the board, its
  //    order is fulfilled, and a second tablet's late click is refused.
  const handed = await advance(
    queuePath,
    staff.session,
    taroEntry.fulfillmentId,
    "hand_over",
  );
  expect(handed.status, JSON.stringify(handed.body)).toBe(200);
  const late = await advance(
    queuePath,
    staff.session,
    taroEntry.fulfillmentId,
    "hand_over",
  );
  expect(late.status).toBe(409);
  expect(late.body).toMatchObject({ error: "order_queue_changed" });
  const finalBoard = await waitForBoard(token, {
    preparing: [thirdCode],
    ready: [cookieCode],
  });
  expect(JSON.stringify(finalBoard)).not.toContain(BUYER_EMAIL);
  const order = await required(admin.readOrderRecord(merchantId, taro.orderId));
  expect(JSON.stringify(order)).toContain("fulfilled");

  // 10. A wrong token reads no codes.
  const forged = `${token.slice(0, -4)}AAAA`;
  expect((await screenRead("pickup", forged)).status).toBe(401);
  await closeSocket(socket);

  task.meta.orderQueue = {
    codes: { taro: "made to order", cookie: "from the case", third: "open" },
    signalAfterMs,
    refusals: {
      viewerRead: "organisation_role_insufficient",
      earlyHandOver: early.status,
      secondTablet: late.status,
      forgedToken: 401,
    },
    finalBoard: {
      preparing: finalBoard.preparing.length,
      ready: finalBoard.ready.length,
    },
  };
}

/**
 * A buyer's card is declined on the QR order page, and the same buyer pays on a
 * new checkout. Only the provider's answer is a stand-in: the Portal's read goes
 * through the control route to Commerce's attempts.
 */
async function failedPaymentsJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`failed-owner-${crypto.randomUUID()}`);
  const staff = await commerceClient(`failed-staff-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`failed-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Failed payment café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_failed_cafe_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await organisationDatabase(organisationId).batch([
    ...member(organisationId, staff.identity.userId, "operator"),
    ...member(organisationId, viewer.identity.userId, "viewer"),
  ]);
  const admin = new CommerceAdminClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    }),
  );
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  const base = `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}`;
  await publishMenu(base, owner.session, admin, merchantId);

  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://commerce.test",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const session = await required(
    buyer.createSession(merchantId, STOREFRONT, {
      schemaVersion: "commerce.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  const declinedAttempt = await declineOrder(
    buyer,
    admin,
    merchantId,
    session.token,
  );
  const { orderId } = await placeOrder(
    merchantId,
    "failed-retry",
    TARO_LINE,
    session.token,
  );

  const now = Date.now();
  const path = `${base}/commerce/failed-payments?from=${String(now - 3_600_000)}&to=${String(now + 3_600_000)}`;

  // A viewer sees no list, and a window longer than a month is refused.
  const refused = await send(path, viewer.session, "GET");
  expect(refused.body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const tooLong = await send(
    `${base}/commerce/failed-payments?from=0&to=${String(now)}`,
    staff.session,
    "GET",
  );
  expect(tooLong.status).toBe(422);

  // Staff read a month as they read a day.
  const month = await send(
    `${base}/commerce/failed-payments?from=${String(now - 31 * 86_400_000)}&to=${String(now + 3_600_000)}`,
    staff.session,
    "GET",
  );
  expect(parseFailedPaymentsDay(month.body)?.steps.length).toBeGreaterThan(0);

  // How long the order took: staff read it, with no buyer named, and a viewer
  // and a window longer than a month are refused.
  const timesPath = `${base}/commerce/order-times?from=${String(now - 3_600_000)}&to=${String(now + 3_600_000)}`;
  const times = await send(timesPath, staff.session, "GET");
  expect(times.status, JSON.stringify(times.body)).toBe(200);
  const timed = parseOrderTimes(times.body);
  expect(timed.orders.map((order) => order.orderId)).toEqual([orderId]);
  expect(timed.orders[0]?.lines).toEqual([
    { title: "Taro Milk Tea", quantity: 1 },
  ]);
  expect(JSON.stringify(times.body)).not.toContain(BUYER_EMAIL);
  expect((await send(timesPath, viewer.session, "GET")).body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const timesTooLong = await send(
    `${base}/commerce/order-times?from=0&to=${String(now)}`,
    staff.session,
    "GET",
  );
  expect(timesTooLong.status).toBe(422);

  // The money that reaches the bank: staff read it, and a viewer and a window
  // longer than a month are refused. This shop has connected no provider.
  const today = new Date(now).toISOString().slice(0, 10);
  const nextDay = new Date(now + 86_400_000).toISOString().slice(0, 10);
  const payoutsPath = `${base}/commerce/bank-payouts?from=${today}&to=${nextDay}`;
  const payouts = await send(payoutsPath, staff.session, "GET");
  expect(payouts.status, JSON.stringify(payouts.body)).toBe(200);
  expect(parseBankPayouts(payouts.body)).toEqual({
    sources: [],
    truncated: false,
    payouts: [],
  });
  expect((await send(payoutsPath, viewer.session, "GET")).body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const payoutsTooLong = await send(
    `${base}/commerce/bank-payouts?from=2020-01-01&to=${today}`,
    staff.session,
    "GET",
  );
  expect(payoutsTooLong.status).toBe(422);

  // Staff see what was bought, why the card failed and that the buyer paid.
  const read = await send(path, staff.session, "GET");
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const day = parseFailedPaymentsDay(read.body);
  expect(day.truncated).toBe(false);
  expect(
    day.steps.map((step) => ({
      follows: step.follows,
      state: step.state,
      reasonCode: step.reasonCode,
      orderCode: step.orderCode,
      lines: step.lines,
    })),
  ).toEqual([
    {
      follows: null,
      state: "declined",
      reasonCode: "card_declined",
      orderCode: null,
      lines: [{ title: "Taro Milk Tea", quantity: 1 }],
    },
    {
      follows: declinedAttempt,
      state: "paid",
      reasonCode: null,
      orderCode: commercePickupCode(orderId),
      lines: [{ title: "Taro Milk Tea", quantity: 1 }],
    },
  ]);
  expect(JSON.stringify(read.body)).not.toContain(BUYER_EMAIL);

  // The Payments page reads the same attempts, and a payment that no decline
  // came before shows as paid on its own. A viewer and a window longer than a
  // month are refused here too.
  const paymentsPath = `${base}/commerce/payments?from=${String(now - 3_600_000)}&to=${String(now + 3_600_000)}`;
  const payments = await send(paymentsPath, staff.session, "GET");
  expect(payments.status, JSON.stringify(payments.body)).toBe(200);
  const everyPayment = parsePaymentsDay(payments.body);
  expect(everyPayment.truncated).toBe(false);
  expect(
    everyPayment.steps.map((step) => ({
      follows: step.follows,
      state: step.state,
      orderCode: step.orderCode,
    })),
  ).toEqual([
    { follows: null, state: "declined", orderCode: null },
    {
      follows: declinedAttempt,
      state: "paid",
      orderCode: commercePickupCode(orderId),
    },
  ]);
  expect(JSON.stringify(payments.body)).not.toContain(BUYER_EMAIL);
  expect((await send(paymentsPath, viewer.session, "GET")).body).toMatchObject({
    error: "organisation_role_insufficient",
  });
  const paymentsTooLong = await send(
    `${base}/commerce/payments?from=0&to=${String(now)}`,
    staff.session,
    "GET",
  );
  expect(paymentsTooLong.status).toBe(422);
  expect(paymentsTooLong.body).toMatchObject({
    error: "payments_window_invalid",
  });

  task.meta.failedPayments = {
    steps: day.steps.length,
    recovered: day.steps.some((step) => step.state === "paid"),
    refusals: {
      viewerRead: "organisation_role_insufficient",
      longWindow: tooLong.status,
    },
  };
}

/** The buyer starts a card payment, and the provider declines it. */
async function declineOrder(
  buyer: CommerceStorefrontClient,
  admin: CommerceAdminClient,
  merchantId: string,
  token: string,
): Promise<string> {
  const cart = await required(
    buyer.createCart(merchantId, STOREFRONT, token, {
      schemaVersion: "commerce.create-buyer-cart.v1",
      idempotencyKey: "cart-failed-first",
      lines: [TARO_LINE],
    }),
  );
  const checkout = await required(
    buyer.createPickupCheckout(merchantId, STOREFRONT, token, {
      schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
      idempotencyKey: "checkout-failed-first",
      cartId: cart.cartId,
      cartRevision: cart.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: BUYER_EMAIL },
      },
    }),
  );
  const payment = await required(
    buyer.createPaymentSession(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: "payment-failed-first",
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        returnUrl: "https://commerce.test/return",
      },
    ),
  );
  if (payment.state !== "ready") throw new Error("No payment session");
  const snapshot = await required(admin.readSnapshot(merchantId));
  const declined = await required(
    admin.resolveCheckoutPayment({
      merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: "decline-failed-first",
      checkoutId: checkout.checkoutId,
      checkoutRevision: payment.checkoutRevision + 1,
      quoteDigest: checkout.quote.quoteDigest,
      paymentAttemptId: payment.paymentAttemptId,
      paymentAttemptRevision: 1,
      outcome: { kind: "declined", reasonCode: "card_declined" },
    }),
  );
  expect(declined.outcome).toBe("applied");
  return payment.paymentAttemptId;
}

function member(
  organisationId: string,
  userId: string,
  role: "operator" | "viewer",
): D1PreparedStatement[] {
  const personId = `person_queue_${role}`;
  return [
    organisationDatabase(organisationId).prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisationId, personId, role),
    organisationDatabase(organisationId).prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
    ).bind(organisationId, userId, personId, role, Date.now()),
  ];
}

async function send(
  url: string,
  session: IssuedControlSession,
  method: "GET" | "POST",
  body?: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers =
    method === "GET"
      ? new Headers(controlReadHeaders(session))
      : commerceHeaders(session);
  if (method !== "GET") {
    headers.set("idempotency-key", idempotencyKey);
    headers.set("x-pantry-configuration-version", "1");
  }
  const response = await exports.default.fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function advance(
  queuePath: string,
  session: IssuedControlSession,
  fulfillmentId: string,
  action: "start" | "ready" | "hand_over",
  idempotencyKey?: string,
): ReturnType<typeof send> {
  return send(
    `${queuePath}/${encodeURIComponent(fulfillmentId)}/advance`,
    session,
    "POST",
    { action },
    idempotencyKey,
  );
}

async function readQueue(
  queuePath: string,
  session: IssuedControlSession,
): Promise<readonly OrderQueueEntry[]> {
  return entriesOf((await send(queuePath, session, "GET")).body);
}

function entriesOf(body: unknown): readonly OrderQueueEntry[] {
  const entries = parseOrderQueueEntries(isRecord(body) ? body.entries : null);
  if (entries === null) throw new Error(`No queue: ${JSON.stringify(body)}`);
  return entries;
}

function entryFor(
  entries: readonly OrderQueueEntry[],
  code: string,
): OrderQueueEntry {
  const entry = entries.find((candidate) => candidate.code === code);
  if (entry === undefined) throw new Error(`No order ${code} in the queue`);
  return entry;
}

function screenRead(path: "feed" | "pickup", token: string): Promise<Response> {
  return exports.default.fetch(`${PUBLIC_ORIGIN}/v1/screens/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function boardCodes(token: string): Promise<MenuScreenPickup> {
  const response = await screenRead("pickup", token);
  expect(response.status).toBe(200);
  const pickup = parseMenuScreenPickup(await response.json());
  if (pickup === null) throw new Error("The pickup codes did not parse");
  return pickup;
}

async function waitForBoard(
  token: string,
  wanted: Readonly<{
    preparing: readonly string[];
    ready: readonly string[];
  }>,
): Promise<MenuScreenPickup> {
  let last: MenuScreenPickup | null = null;
  await expect
    .poll(
      async () => {
        last = await boardCodes(token);
        return {
          preparing: [...last.preparing].sort(),
          ready: [...last.ready].sort(),
        };
      },
      { timeout: 20_000, interval: 250 },
    )
    .toEqual({
      preparing: [...wanted.preparing].sort(),
      ready: [...wanted.ready].sort(),
    });
  if (last === null) throw new Error("No board read");
  return last;
}

async function boardRevision(
  base: string,
  session: IssuedControlSession,
  boardId: string,
): Promise<number> {
  const listed = await send(`${base}/menu-boards`, session, "GET");
  const boards = isRecord(listed.body) ? listed.body.boards : null;
  const board = Array.isArray(boards)
    ? boards.find(
        (candidate) => isRecord(candidate) && candidate.boardId === boardId,
      )
    : null;
  if (!isRecord(board) || typeof board.documentRevision !== "number")
    throw new Error(`No board revision: ${JSON.stringify(listed.body)}`);
  return board.documentRevision;
}

async function pairedScreen(
  base: string,
  session: IssuedControlSession,
  boardId: string,
): Promise<string> {
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/pairings`,
    { method: "POST" },
  );
  const pairing = parseMenuScreenPairing(await started.json());
  if (pairing === null) throw new Error("No pairing");
  const paired = await send(`${base}/menu-screens`, session, "POST", {
    code: pairing.code,
    name: "Pickup TV",
    boardId,
  });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/pairings/${pairing.pairingId}`,
    { headers: { Authorization: `Bearer ${pairing.secret}` } },
  );
  const state = parseMenuScreenPairingState(await response.json());
  if (state?.state !== "paired") throw new Error("Screen not paired");
  return state.token;
}

async function openScreenSocket(token: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/screens/socket`,
    {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `${MENU_SCREEN_SOCKET_PROTOCOL}, ${token}`,
      },
    },
  );
  expect(response.status).toBe(101);
  if (response.webSocket === null) throw new Error("No screen socket");
  response.webSocket.accept();
  return response.webSocket;
}

/** One customer on the QR order page: a cart, a checkout and a payment. */
async function placeOrder(
  merchantId: string,
  key: string,
  line: CommerceBuyerCartLineV1,
  openSession?: string,
): Promise<Readonly<{ orderId: string }>> {
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://commerce.test",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const token =
    openSession ??
    (
      await required(
        buyer.createSession(merchantId, STOREFRONT, {
          schemaVersion: "commerce.create-buyer-session.v1",
          buyer: { kind: "guest" },
        }),
      )
    ).token;
  const cart = await required(
    buyer.createCart(merchantId, STOREFRONT, token, {
      schemaVersion: "commerce.create-buyer-cart.v1",
      idempotencyKey: `cart-${key}`,
      lines: [line],
    }),
  );
  const checkout = await required(
    buyer.createPickupCheckout(merchantId, STOREFRONT, token, {
      schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
      idempotencyKey: `checkout-${key}`,
      cartId: cart.cartId,
      cartRevision: cart.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: BUYER_EMAIL },
      },
    }),
  );
  const payment = await required(
    buyer.createPaymentSession(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: `payment-${key}`,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        returnUrl: "https://commerce.test/return",
      },
    ),
  );
  if (payment.state !== "ready") throw new Error("No payment session");
  const placed = await required(
    buyer.reconcilePayment(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      token,
      {
        schemaVersion: "commerce.reconcile-buyer-payment.v1",
        idempotencyKey: `payment-${key}`,
        checkoutRevision: payment.checkoutRevision,
        quoteDigest: checkout.quote.quoteDigest,
        confirmation: { kind: "provider_ui_completed" },
      },
    ),
  );
  if (placed.state !== "placed") throw new Error(`Payment ${placed.state}`);
  return { orderId: placed.orderId };
}

/** The owner puts a drink and a cookie on the menu, through the shared draft. */
async function publishMenu(
  base: string,
  session: IssuedControlSession,
  admin: CommerceAdminClient,
  merchantId: string,
): Promise<void> {
  const stock = await required(admin.readStockSnapshot(merchantId));
  const productId = (title: string): string => {
    const product = stock.commerce.resources.products.find(
      (candidate) => candidate.title === title,
    );
    if (product === undefined) throw new Error(`No product ${title}`);
    return product.id;
  };
  const socket = await openSocket(
    `${base}/collaboration/menu-draft/socket`,
    session,
  );
  const menu = MenuDraftDoc.createReplica();
  try {
    const sync = await nextDraftMessage(socket, "sync_response", () => {
      const vector = menu.stateVector();
      if (!vector.ok) throw new Error(vector.error.code);
      socket.send(
        encodeMenuDraftClientMessage({
          kind: "sync_request",
          stateVector: vector.value,
        }),
      );
    });
    if (sync.kind !== "sync_response") throw new Error("No menu sync");
    const applied = menu.apply(sync.missingUpdate);
    if (!applied.ok) throw new Error(applied.error.code);
    await submitDraft(
      socket,
      "drinks",
      menu.addSection({ id: "section_drinks", title: "Drinks", order: 1 }),
    );
    await submitDraft(
      socket,
      "taro",
      menu.addItem({
        id: TARO,
        productId: productId("Taro Milk Tea"),
        displayName: "Taro Milk Tea",
        description: "",
        placement: { sectionId: "section_drinks", order: 0 },
      }),
    );
    await submitDraft(
      socket,
      "cookie",
      menu.addItem({
        id: COOKIE,
        productId: productId("Taro Cookie"),
        displayName: "Taro Cookie",
        description: "",
        placement: { sectionId: "section_drinks", order: 1 },
      }),
    );
  } finally {
    menu.destroy();
    await closeSocket(socket);
  }
  const draft = await send(`${base}/collaboration/menu-draft`, session, "GET");
  if (
    !isRecord(draft.body) ||
    !isRecord(draft.body.value) ||
    typeof draft.body.value.revision !== "number"
  )
    throw new Error(`No draft revision: ${JSON.stringify(draft.body)}`);
  const published = await send(
    `${base}/commerce/menu-publication`,
    session,
    "POST",
    { documentRevision: draft.body.value.revision },
  );
  expect(published.status, JSON.stringify(published.body)).toBe(200);
}

async function submitDraft(
  socket: WebSocket,
  updateId: string,
  result:
    | Readonly<{ ok: true; value: MenuDraftUpdate }>
    | Readonly<{ ok: false; error: { code: string } }>,
): Promise<void> {
  if (!result.ok) throw new Error(result.error.code);
  const update = result.value;
  await nextDraftMessage(socket, "update_accepted", () =>
    socket.send(
      encodeMenuDraftClientMessage({
        kind: "submit_update",
        updateId,
        update,
      }),
    ),
  );
}

type DraftMessage = Extract<
  ReturnType<typeof parseMenuDraftServerMessage>,
  { ok: true }
>["value"];

function nextDraftMessage(
  socket: WebSocket,
  kind: DraftMessage["kind"],
  start: () => void,
): Promise<DraftMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`No ${kind} message`));
    }, 10_000);
    const onMessage = (event: MessageEvent): void => {
      const parsed = parseMenuDraftServerMessage(event.data);
      if (!parsed.ok) return;
      if (parsed.value.kind === "failure") {
        clearTimeout(timer);
        reject(new Error(`Room failure: ${JSON.stringify(parsed.value)}`));
        return;
      }
      if (parsed.value.kind !== kind) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(parsed.value);
    };
    socket.addEventListener("message", onMessage);
    start();
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
