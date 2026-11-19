async (page) => {
  // The Products panel of the board editor (Plan 40B), in two real
  // browsers on one board, against a local Worker with its own D1 (the
  // Plan 74 harness).
  //
  // The owner drags a product that is not on the menu onto a free canvas:
  // it goes into the menu draft and shows on the board as a card. The
  // inspector changes its look to a tile and to a big price; the admin's
  // browser shows each look. The product's + button adds it again at the
  // board's centre, and the Items tab lists it in the menu draft. The
  // product has a photo in the shop: the Products panel shows it, and a
  // paired TV shows it on the product's card.
  //
  // Run: PANTRY_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-board-products.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-products
  //
  // The harness Worker has no shop, so this browser answers the product
  // list read, the photo's bytes and the TV feed's shop facts, as
  // browser-sold-out.js does; it records no write. The E2E journey
  // services/platform/tests/e2e/pi-menu-board-products.test.ts proves that
  // the server gives the photo in those reads.
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const fixtures = JOURNEY_FIXTURES;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const PRODUCT = "Taro Milk Tea";
  const PHOTO = { url: "https://photos.test/taro-milk-tea.svg", altText: "Taro milk tea in a tall glass" };
  const PHOTO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#b9a3d6"/><circle cx="200" cy="150" r="90" fill="#efe6f7"/></svg>';
  const checks = [];
  const captures = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const capture = async (target, name) => {
    await target.screenshot({ path: `${ARTIFACTS}/${name}.png` });
    captures.push(`${name}.png`);
  };
  const boardUrl = `${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`;
  const products = (target) => target.locator(".menu-board-canvas-element.menu-board-element-featured");
  const until = async (name, read, test, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
      value = await read();
      if (test(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    check(name, false, value);
    return value;
  };

  await page.context().route("**/commerce/menu-publication", (route) => route.request().method() === "GET"
    ? route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        products: [
          { productId: "product_taro", title: PRODUCT, image: PHOTO },
          { productId: "product_oat", title: "Oat Latte", image: null },
        ],
        published: null,
        hours: null,
        shopUrl: null,
        shopName: null,
      }),
    })
    : route.continue());
  await page.context().route("https://photos.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: PHOTO_SVG }));
  const photoLoaded = (image) => image.evaluate((element) => element.complete && element.naturalWidth > 0);
  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(boardUrl);
  const start = page.locator(".menu-board-start");
  await start.waitFor({ timeout: 15_000 });
  await start.locator('input[value="canvas_landscape:blank"]').check();
  await start.getByLabel("Name", { exact: true }).fill("Drinks");
  await start.getByRole("button", { name: "Create board", exact: true }).click();
  await start.waitFor({ state: "detached", timeout: 15_000 });
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });

  // 1. The Products tab lists the shop's products that are not on the menu.
  await page.getByRole("tab", { name: "Products", exact: true }).click();
  const panel = page.getByRole("region", { name: "Products" });
  const row = panel.locator(".menu-board-product", { hasText: PRODUCT });
  await row.waitFor({ timeout: 15_000 });
  check("the product is not on the menu yet", (await row.textContent()).includes("Adds it to the menu draft"));
  const thumbnail = row.locator("img.menu-board-product-mark");
  await thumbnail.waitFor({ timeout: 15_000 });
  check("the panel shows the product's photo", await until("the panel photo loads", () => photoLoaded(thumbnail), Boolean));
  check("the product without a photo keeps its letter", (await panel.locator(".menu-board-product", { hasText: "Oat Latte" }).locator("span.menu-board-product-mark").textContent()) === "O");
  await capture(page, "01-products");

  // 2. A drag onto the canvas adds it to the menu draft and the board.
  const frame = await page.locator(".menu-board-stage .menu-board-frame").boundingBox();
  const viewport = await page.locator(".menu-board-viewport").boundingBox();
  await row.dragTo(page.locator(".menu-board-viewport"), {
    targetPosition: { x: frame.x + frame.width * 0.3 - viewport.x, y: frame.y + frame.height * 0.5 - viewport.y },
  });
  await until("the product shows on the board", () => products(page).count(), (count) => count === 1);
  check("the card names the product", (await products(page).first().textContent()).includes(PRODUCT));
  await until("the panel lists it on the menu draft", () => panel.locator(".menu-board-product", { hasText: PRODUCT }).first().textContent(),
    (text) => text.includes("Not on the published menu yet"));
  const drawer = page.getByRole("complementary", { name: "Selected product" });
  await drawer.waitFor();
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await capture(page, "02-dropped");

  // 3. The admin opens the board; the looks change in both browsers.
  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.setViewportSize({ width: 1440, height: 1000 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await until("the admin sees the card", () => products(other).count(), (count) => count === 1);
  await drawer.getByRole("group", { name: "Look" }).getByRole("button", { name: "Tile", exact: true }).click();
  await until("the admin sees the tile", () => products(other).locator('.menu-board-items[data-row="tiles"]').count(), (count) => count === 1);
  await drawer.getByRole("group", { name: "Look" }).getByRole("button", { name: "Big price", exact: true }).click();
  await until("the admin sees the big price", () => products(other).locator(".menu-board-product-price").count(), (count) => count === 1);
  await capture(other, "03-admin-big-price");

  // 4. The + button adds it again at the board's centre.
  await panel.getByRole("button", { name: `Add ${PRODUCT} to the board`, exact: true }).first().click();
  await until("two products on the board", () => products(page).count(), (count) => count === 2);
  await until("the admin sees both", () => products(other).count(), (count) => count === 2);
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await capture(page, "04-two");

  // 5. A paired TV shows the photo on the card, and none on the big price.
  // The browser answers the feed's shop facts with the photo.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Published revision 1.", { exact: false }).first().waitFor({ timeout: 15_000 });
  const tv = await page.context().newPage();
  await tv.setViewportSize({ width: 1280, height: 720 });
  await tv.route("**/v1/screens/feed", async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    feed.facts = {
      observedAt: Date.now(),
      entries: (feed.release?.items ?? []).map((item) => ({
        menuEntryId: item.itemId,
        price: { amountMinor: 650, currency: "JPY" },
        availability: "available",
        image: PHOTO,
      })),
      orderUrl: null,
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feed) });
  });
  await tv.goto(`${PORTAL}/tv`);
  const codeText = tv.locator(".tv-code");
  await codeText.waitFor({ timeout: 15_000 });
  const code = (await codeText.textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await page.getByRole("button", { name: "Add a screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a screen" });
  await dialog.getByLabel("Code from the screen").fill(code.toLowerCase());
  await dialog.getByLabel("Name", { exact: true }).fill("Window TV");
  await dialog.getByRole("button", { name: "Pair screen", exact: true }).click();
  await page.getByText("Window TV", { exact: true }).waitFor({ timeout: 15_000 });
  const tvPhotos = tv.locator(".menu-board .menu-board-photo");
  await tvPhotos.first().waitFor({ timeout: 30_000 });
  check("the TV shows one photo, on the card", (await tvPhotos.count()) === 1 &&
    (await tv.locator(".menu-board-featured[data-photo=\"true\"] .menu-board-photo").count()) === 1);
  check("the TV photo loads with its alt text", await until("the TV photo loads", () => photoLoaded(tvPhotos.first()), Boolean) &&
    (await tvPhotos.first().getAttribute("alt")) === PHOTO.altText);
  check("the big price shows no photo", (await tv.locator(".menu-board-product-price").count()) === 1);
  await capture(tv, "05-tv-photo");

  // 6. The Menu items sheet lists the product in the menu draft. The
  // Screens drawer is modal, so it closes first.
  await page.getByRole("dialog", { name: "Screens" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Menu items", exact: true }).click();
  await page.getByRole("dialog", { name: "Menu items" }).waitFor({ timeout: 15_000 });
  await page.getByLabel(`Name of ${PRODUCT}`).first().waitFor({ timeout: 15_000 });
  check("the menu draft has the product", true);
  await otherContext.close();
  return { result: "passed", checks, captures };
}
