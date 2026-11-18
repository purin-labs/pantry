async (page) => {
  // "Sold out today" and serving hours in a browser (Plan 40B phase 3), on the
  // Plan 74 harness. The Worker is real for the menu draft, boards and pairing.
  // This shop has no Commerce merchant, so the browser answers the marks, the
  // publication and the screen's facts with the shapes of the E2E journey
  // services/platform/tests/e2e/order-queue.test.ts, which proves the server.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-sold-out.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-sold-out
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const fixtures = JOURNEY_FIXTURES;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
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
  // The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
    if ("values" in choice) {
      const wanted = choice.values.map(String);
      for (const item of await items.all()) {
        const chosen = wanted.includes(await item.getAttribute("data-value"));
        const selected = (await item.getAttribute("aria-selected")) === "true";
        if (chosen !== selected) await item.click();
      }
      await page.keyboard.press("Escape");
    } else if ("value" in choice) {
      await popup
        .locator(
          `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
        )
        .click();
    } else if ("label" in choice) {
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }

  const json = (route, status, body) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  const items = [
    { variantId: "variant_taro", title: "Taro Milk Tea", soldOutUntil: null },
    { variantId: "variant_cookie", title: "Taro Cookie", soldOutUntil: null },
  ];
  const markBodies = [];
  let refuseMarks = false;
  await page.context().route("**/commerce/order-queue**", (route) =>
    json(route, 200, { ok: true, entries: [] }),
  );
  await page.context().route("**/commerce/sold-out**", (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return json(route, 200, { ok: true, items });
    if (refuseMarks)
      return json(route, 409, { ok: false, error: "sold_out_refused" });
    const variantId = decodeURIComponent(
      new URL(request.url()).pathname.split("/").at(-1) ?? "",
    );
    const body = request.postDataJSON();
    markBodies.push(body);
    const item = items.find((candidate) => candidate.variantId === variantId);
    item.soldOutUntil = body.soldOut
      ? new Date(Date.now() + 3_600_000).toISOString()
      : null;
    return json(route, 200, { ok: true, soldOut: body.soldOut });
  });

  let publishedHours = null;
  let published = null;
  const publishBodies = [];
  await page.context().route("**/commerce/menu-publication", (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return json(route, 200, {
        ok: true,
        products: [{ productId: "product_taro", title: "Taro Milk Tea" }],
        shopUrl: null,
        shopName: null,
        published,
        hours: publishedHours,
      });
    const body = request.postDataJSON();
    publishBodies.push(body);
    publishedHours = body.hours;
    published = { revision: publishBodies.length, entries: 1 };
    return json(route, 200, {
      ok: true,
      menu: {
        menuId: "menu_cafe_main",
        revision: publishBodies.length,
        entries: 1,
        documentRevision: body.documentRevision,
      },
    });
  });

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");

  // 1. Staff mark a drink as sold out from the queue page on a tablet.
  const queue = await page.context().newPage();
  await queue.setViewportSize({ width: 1024, height: 768 });
  await queue.goto(
    `${PORTAL}/order-queue-preview.html?organisation=${fixtures.organisationId}`,
  );
  const row = (title) =>
    queue.locator(".order-queue-sold-out-row", { hasText: title });
  await row("Taro Milk Tea").waitFor({ timeout: 15_000 });
  await capture(queue, "01-items-on-sale");
  await row("Taro Milk Tea")
    .getByRole("button", { name: "Mark sold out", exact: true })
    .click();
  await row("Taro Milk Tea")
    .getByRole("button", { name: "Put back on sale", exact: true })
    .waitFor({ timeout: 10_000 });
  check("the mark names this device's time zone",
    markBodies[0]?.soldOut === true &&
      markBodies[0]?.timeZone ===
        (await queue.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)),
    markBodies[0]);
  check("the other item stays on sale",
    (await row("Taro Cookie").getAttribute("data-sold-out")) === null);
  await capture(queue, "02-item-sold-out");

  // 2. A refusal tells the person, and the item stays as it was.
  refuseMarks = true;
  await row("Taro Cookie")
    .getByRole("button", { name: "Mark sold out", exact: true })
    .click();
  await queue.getByRole("alert").filter({ hasText: "Taro Cookie did not change." })
    .waitFor({ timeout: 10_000 });
  refuseMarks = false;

  // 3. Staff put the drink back.
  await row("Taro Milk Tea")
    .getByRole("button", { name: "Put back on sale", exact: true })
    .click();
  await row("Taro Milk Tea")
    .getByRole("button", { name: "Mark sold out", exact: true })
    .waitFor({ timeout: 10_000 });
  check("clearing the mark sends no sold-out state", markBodies.at(-1)?.soldOut === false);
  await queue.setViewportSize({ width: 390, height: 800 });
  check("the phone layout has no sideways scroll",
    await queue.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await capture(queue, "03-items-phone");
  await queue.close();

  // 4. The owner gives the menu serving hours and publishes it.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=items`);
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  const add = page.getByRole("combobox", { name: /Add an item to/u }).first();
  await add.waitFor({ timeout: 15_000 });
  await chooseOption(page, add, { value: "product_taro" });
  await page.getByLabel("Name of Taro Milk Tea").waitFor({ timeout: 15_000 });
  const hours = page.getByRole("group", { name: "Serving hours" });
  const allDay = hours.getByRole("checkbox", { name: "All day", exact: true });
  check("a new menu serves all day", await allDay.isChecked());
  await allDay.uncheck();
  const first = hours.getByRole("group", { name: "Hours 1" });
  await first.getByRole("checkbox", { name: "Sat", exact: true }).uncheck();
  await first.getByRole("checkbox", { name: "Sun", exact: true }).uncheck();
  await first.getByLabel("From").fill("07:30");
  await first.getByLabel("To").fill("10:30");
  await hours.getByRole("button", { name: "Add hours", exact: true }).click();
  const second = hours.getByRole("group", { name: "Hours 2" });
  await second.getByLabel("From").fill("17:00");
  await second.getByLabel("To").fill("21:00");
  await capture(page, "04-hours-editor");
  await page.getByRole("button", { name: "Publish menu", exact: true }).click();
  await page.getByText("Published revision 1", { exact: false }).waitFor({ timeout: 15_000 });
  const sent = publishBodies[0]?.hours;
  check("the publication carries both slots on the shop's clock",
    sent?.slots?.length === 2 &&
      JSON.stringify(sent.slots[0]) === JSON.stringify({
        days: ["mon", "tue", "wed", "thu", "fri"],
        startsAt: "07:30",
        endsAt: "10:30",
      }) &&
      sent.slots[1].startsAt === "17:00" &&
      sent.timeZone === (await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)),
    sent);

  // 5. The page opens again with those hours, and "All day" clears them.
  await page.reload();
  const reopened = page.getByRole("group", { name: "Serving hours" });
  await reopened.getByRole("group", { name: "Hours 2" }).waitFor({ timeout: 15_000 });
  check("the saved hours return",
    (await reopened.getByRole("group", { name: "Hours 1" }).getByLabel("From").inputValue()) === "07:30");
  await reopened.getByRole("checkbox", { name: "All day", exact: true }).check();
  await page.getByRole("button", { name: "Publish menu", exact: true }).click();
  await page.getByText("Published revision 2", { exact: false }).waitFor({ timeout: 15_000 });
  check("all day clears the hours", publishBodies[1]?.hours === null, publishBodies[1]);

  // 6. A TV outside the menu's hours says so, and shows no prices.
  await page.goto(`${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`);
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Drinks");
  await page.locator(`.menu-boards-new input[value="three_columns:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Published revision 1.", { exact: false }).first().waitFor({ timeout: 15_000 });
  const tv = await page.context().newPage();
  await tv.setViewportSize({ width: 1280, height: 720 });
  let notServing = false;
  await tv.route("**/v1/screens/feed", async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    feed.facts = {
      observedAt: Date.now(),
      entries: notServing
        ? []
        : (feed.release?.content?.items ?? []).map((item) => ({
            menuEntryId: item.itemId,
            price: { amountMinor: 600, currency: "JPY" },
            availability: "available",
          })),
      orderUrl: null,
    };
    return json(route, 200, feed);
  });
  await tv.goto(`${PORTAL}/tv`);
  const codeText = tv.locator(".tv-code");
  await codeText.waitFor({ timeout: 15_000 });
  const code = (await codeText.textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await page.getByRole("button", { name: "Add a screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a screen" });
  await dialog.getByLabel("Code from the screen").fill(code.toLowerCase());
  await dialog.getByLabel("Name", { exact: true }).fill("Bar TV");
  await dialog.getByRole("button", { name: "Pair screen", exact: true }).click();
  await page.getByText("Bar TV", { exact: true }).waitFor({ timeout: 15_000 });
  await tv.locator(".menu-board").waitFor({ timeout: 30_000 });
  notServing = true;
  await tv.reload();
  const closed = tv.locator(".menu-board-not-serving");
  await closed.waitFor({ timeout: 30_000 });
  check("the TV says that the menu is not serving",
    (await closed.textContent()) === "Not serving now");
  check("the TV shows no prices and no missing-item text",
    (await tv.locator(".menu-board-price").count()) === 0 &&
      (await tv.locator(".menu-board-missing").count()) === 0);
  await capture(tv, "05-tv-not-serving");
  return { result: "passed", checks, captures };
}
