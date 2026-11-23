async (page) => {
  // The shop screen's player at /tv in a browser (Plan 40B phase 1).
  //
  // The built Portal serves /tv with its service worker. This browser answers
  // the screen API and the signal socket with the shapes that the Pantry
  // Worker answers in workers/platform/tests/e2e/menu-board-screen.test.ts,
  // so that the check covers the player alone: pairing, playing, a signal,
  // the saved copy while offline, a restart with no network, the catch-up
  // after reconnect, and the end of the pairing.
  const PORTAL = "http://127.0.0.1:3140";
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const ORGANISATION = "organisation_screen_journey";
  const SCREEN = "screen_0123456789abcdef0123";
  const TOKEN = `scr1.${ORGANISATION}.${SCREEN}.${"A".repeat(43)}`;
  const PAIRING = {
    pairingId: "pairing_0123456789abcdef01234567",
    code: "K7Q4MX",
    secret: "B".repeat(43),
    expiresAt: Date.now() + 10 * 60_000,
  };
  const SIGNAL = JSON.stringify({ kind: "menu_screen_changed" });
  const placement = (frameId, order) => ({ frameId, order });
  const release = {
    boardId: "board_0123456789abcdef0123",
    releaseRevision: 1,
    digest: "291bd44bec0f6380088706e6fbee7a5351cdd144c4cbfbb1da8e651abd732d48",
    publishedAt: Date.now() - 60_000,
    title: "Drinks",
    layout: "three_columns",
    elements: [
      { id: "element_0000000000000001", kind: "heading", placement: placement("header", 0), eyebrow: "Cafe / Patisserie", title: "Coffee & tea", detail: "Prices include tax · 税込" },
      { id: "element_0000000000000002", kind: "section", placement: placement("column_1", 0), sectionId: "section_drinks", note: "Taiwanese and Japanese teas" },
      { id: "element_0000000000000003", kind: "section", placement: placement("column_2", 0), sectionId: "section_bakes", note: "Baked every morning" },
      { id: "element_0000000000000004", kind: "featured", placement: placement("column_3", 0), itemId: "item_taro_milk_tea", label: "Today’s pick", note: "Nutty taro and Assam tea." },
      { id: "element_0000000000000005", kind: "order_qr", placement: placement("column_3", 1), title: "Order ahead", detail: "Scan, pay, and collect at the counter with your pickup code." },
    ],
    sections: [
      { sectionId: "section_drinks", title: "Drinks", itemIds: ["item_taro_milk_tea", "item_ginger_milk_tea", "item_matcha_tea"] },
      { sectionId: "section_bakes", title: "Bakes", itemIds: ["item_taro_cookie", "item_ginger_cookie"] },
    ],
    items: [
      { itemId: "item_taro_milk_tea", name: "Taro Milk Tea", description: "Assam tea, nutty taro, and creamy whole milk." },
      { itemId: "item_ginger_milk_tea", name: "Ginger Milk Tea", description: "" },
      { itemId: "item_matcha_tea", name: "Matcha Tea", description: "" },
      { itemId: "item_taro_cookie", name: "Taro Cookie", description: "" },
      { itemId: "item_ginger_cookie", name: "Ginger Cookie", description: "" },
    ],
  };
  const entry = (menuEntryId, amountMinor, availability = "available") => ({
    menuEntryId,
    price: { amountMinor, currency: "JPY" },
    availability,
  });
  const facts = (taro) => ({
    observedAt: Date.now(),
    entries: [
      entry("item_taro_milk_tea", 700, taro),
      entry("item_ginger_milk_tea", 650),
      entry("item_matcha_tea", 650),
      entry("item_taro_cookie", 495),
      entry("item_ginger_cookie", 495),
    ],
    orderUrl: "https://shop.purin.io/shops/merchant_screen_journey",
  });

  const server = {
    network: true,
    limited: true,
    pairingPolls: 0,
    taro: "available",
    removed: false,
    sockets: [],
    feedReads: 0,
  };
  const checks = [];
  const captures = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const capture = async (name) => {
    await page.screenshot({ path: `${ARTIFACTS}/${name}.png` });
    captures.push(`${name}.png`);
  };
  // CSS upper-cases some labels, so the checks compare lower-case text.
  const visibleText = async () => (await page.locator("#root").innerText()).toLowerCase();
  const waitForText = async (text, timeout = 10_000) => {
    await page.getByText(text, { exact: false }).first().waitFor({ timeout });
  };

  const diagnostics = [];
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => diagnostics.push(`page: ${String(error)}`));
  page.on("requestfailed", (request) =>
    diagnostics.push(`failed: ${request.url()} ${request.failure()?.errorText ?? ""}`),
  );
  await page.setViewportSize({ width: 1600, height: 900 });
  const answer = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!server.network) return route.abort("internetdisconnected");
    if (path === "/v1/screens/pairings" && request.method() === "POST")
      return server.limited
        ? route.fulfill({ status: 429, json: { ok: false, error: "menu_screen_pairing_limit" } })
        : route.fulfill({ status: 201, json: PAIRING });
    if (path === `/v1/screens/pairings/${PAIRING.pairingId}`) {
      server.pairingPolls += 1;
      return route.fulfill({
        json:
          server.removed || server.pairingPolls < 2
            ? { state: "waiting", expiresAt: PAIRING.expiresAt }
            : { state: "paired", token: TOKEN },
      });
    }
    if (path === "/v1/screens/feed") {
      if (server.removed || request.headers().authorization !== `Bearer ${TOKEN}`)
        return route.fulfill({ status: 401, json: { ok: false, error: "menu_screen_refused" } });
      server.feedReads += 1;
      return route.fulfill({
        json: { screen: { screenId: SCREEN, name: "Counter TV" }, release, facts: facts(server.taro) },
      });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: "not_found" } });
  };
  await page.route("**/v1/screens/**", answer);
  await page.routeWebSocket("**/v1/screens/socket", (socket) => {
    if (!server.network) {
      socket.close({ code: 1006, reason: "offline" });
      return;
    }
    server.sockets.push(socket);
    socket.onMessage((message) => {
      if (message === "pantry.ping") socket.send("pantry.pong");
    });
  });
  const signal = () => {
    for (const socket of server.sockets) socket.send(SIGNAL);
  };

  // 0. When this address holds too many open codes, the screen says so
  //    instead of "No network".
  await page.goto(`${PORTAL}/tv`);
  await waitForText("Too many screens on this network");
  check("a refused code shows the address limit, not a lost network", !(await visibleText()).includes("no network"));
  await capture("0-pairing-limit");
  server.limited = false;

  // 1. A new screen shows its pairing code.
  await page.reload();
  await waitForText(PAIRING.code);
  check("the new screen shows its pairing code", (await visibleText()).includes(PAIRING.code.toLowerCase()));
  await capture("1-pairing-code");

  // 2. Once a member pairs it, the screen plays the board with live prices.
  await waitForText("Taro Milk Tea", 15_000);
  await waitForText("¥700");
  const playing = await visibleText();
  check("the paired screen plays its board", playing.includes("coffee & tea") && playing.includes("ginger cookie"), playing);
  check("the board shows no sold-out mark", !playing.includes("sold out"), playing);
  check("the board draws the order QR code", (await page.locator("svg.menu-board-qr rect").count()) > 100);
  await capture("2-playing");

  // 3. The taro powder runs out: one signal, and the screen marks the drink.
  server.taro = "unavailable";
  const readsBefore = server.feedReads;
  signal();
  await waitForText("Sold out");
  check("a signal makes the screen read its feed", server.feedReads > readsBefore, { readsBefore, after: server.feedReads });
  const soldOut = await page.locator('.menu-board-item[data-sold-out="true"]').allInnerTexts();
  check("only the taro milk tea is sold out", soldOut.length === 1 && soldOut[0].includes("Taro Milk Tea"), soldOut);
  await capture("3-sold-out");

  // 4. The network drops. The screen keeps the board and marks it not verified.
  server.network = false;
  for (const socket of server.sockets.splice(0)) socket.close({ code: 1006, reason: "network" });
  await waitForText("Prices and sold-out marks are not verified", 20_000);
  const offline = await visibleText();
  check("offline, the screen keeps the board and the sold-out mark", offline.includes("taro milk tea") && offline.includes("sold out"), offline);
  await capture("4-offline");

  // 5. The screen restarts with no network. The service worker opens the
  //    player, and the player shows its saved copy.
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      active: registration.active?.state ?? null,
      controlled: navigator.serviceWorker.controller !== null,
      kept: (await (await caches.open("pantry-tv-v1")).keys()).map((request) => new URL(request.url).pathname),
    };
  });
  check("the service worker keeps the player", worker.active === "activated" && worker.kept.includes("/tv"), worker);
  // Playwright's request routes pass page requests around a service worker,
  // so the restart runs with the browser offline and no route: the feed then
  // fails as on a TV with no network.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.context().setOffline(true);
  await page.reload().catch(() => undefined);
  try {
    await waitForText("Prices and sold-out marks are not verified", 20_000);
  } catch (error) {
    await capture("5-restart-offline-failed");
    const lookup = await page.evaluate(async (path) => {
      const kept = await caches.match(new Request(path, { mode: "cors", credentials: "same-origin" }));
      return { found: kept !== undefined, vary: kept?.headers.get("vary") ?? null };
    }, worker.kept.find((path) => path.endsWith(".js") && path.includes("/tv-")) ?? "/tv");
    throw new Error(`${String(error)} ${JSON.stringify({ lookup, diagnostics: diagnostics.slice(-12) })}`);
  }
  const restarted = await visibleText();
  check("after a restart offline, the saved board shows", restarted.includes("coffee & tea") && restarted.includes("sold out"), restarted);
  await capture("5-restart-offline");

  // 6. The network comes back after staff restocked: the screen catches up.
  await page.context().setOffline(false);
  await page.route("**/v1/screens/**", answer);
  server.taro = "available";
  server.network = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText("Prices and sold-out marks are not verified").waitFor({ state: "detached", timeout: 40_000 });
  const caughtUp = await visibleText();
  check("after reconnect, the screen shows the live board again", !caughtUp.includes("sold out") && caughtUp.includes("¥700"), caughtUp);
  await capture("6-caught-up");

  // 7. Staff remove the screen: its socket closes with 4403, and it shows a code.
  const deadline = Date.now() + 30_000;
  while (server.sockets.length === 0 && Date.now() < deadline) await page.waitForTimeout(250);
  check("the screen opened its socket again", server.sockets.length > 0);
  server.removed = true;
  for (const socket of server.sockets.splice(0)) socket.close({ code: 4403, reason: "screen_removed" });
  await waitForText(PAIRING.code, 15_000);
  check("a removed screen goes back to a pairing code", (await visibleText()).includes(PAIRING.code.toLowerCase()));
  await capture("7-removed");

  return { result: "passed", checks, captures, feedReads: server.feedReads };
}
