async (page) => {
  // The pickup board and the staff order queue in a browser (Plan 40B phase 3),
  // on the Plan 74 harness. The Worker is real for boards, releases and
  // pairing. This shop has no Commerce merchant, so the browser answers the
  // queue and the codes with the shapes of the E2E journey
  // services/platform/tests/e2e/order-queue.test.ts, which proves the server.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-pickup.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-pickup
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
  // The form value of a Portal Select. Base UI keeps it in a hidden input that
  // it renders after the Select's parts.
  function selectValue(trigger) {
    return trigger.evaluate(function hiddenSelectValue(button) {
      for (let node = button; node !== null; node = node.parentElement) {
        for (
          let next = node.nextElementSibling;
          next !== null;
          next = next.nextElementSibling
        ) {
          if (
            next instanceof HTMLInputElement &&
            next.getAttribute("aria-hidden") === "true"
          )
            return next.value;
        }
      }
      throw new Error("A Portal Select has no hidden input.");
    });
  }

  const minutesAgo = (minutes) =>
    new Date(Date.now() - minutes * 60_000).toISOString();

  // What the shop's Commerce holds. A click moves an order, as the Worker
  // does; a hand-over of the second order is refused as a second tablet's.
  const entries = [
    {
      fulfillmentId: "fulfillment_taro",
      orderId: "order_taro",
      code: "F-062",
      channel: "online",
      stage: "preparing",
      since: minutesAgo(6),
      preparation: "not_started",
      lines: [
        { title: "Taro Milk Tea", quantity: 2, modifiers: ["Oat milk", "Less sweet"] },
        { title: "Espresso", quantity: 1, modifiers: [] },
      ],
    },
    {
      fulfillmentId: "fulfillment_cookie",
      orderId: "order_cookie",
      code: "K-418",
      channel: "online",
      stage: "preparing",
      since: minutesAgo(2),
      preparation: "not_needed",
      lines: [{ title: "Taro Cookie", quantity: 3, modifiers: [] }],
    },
    {
      fulfillmentId: "fulfillment_tin",
      orderId: "order_tin",
      code: "T-731",
      channel: "counter",
      stage: "ready",
      since: minutesAgo(1),
      preparation: "not_needed",
      lines: [{ title: "Financier gift box", quantity: 1, modifiers: [] }],
    },
  ];
  const pickup = () => ({
    observedAt: Date.now(),
    preparing: entries.filter((e) => e.stage === "preparing").map((e) => e.code),
    ready: entries.filter((e) => e.stage === "ready").map((e) => e.code),
  });
  const json = (route, status, body) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await page.context().route("**/v1/screens/pickup", (route) =>
    json(route, 200, pickup()),
  );
  await page.context().route("**/commerce/order-queue**", (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return json(route, 200, { ok: true, entries });
    const fulfillmentId = decodeURIComponent(
      new URL(request.url()).pathname.split("/").at(-2) ?? "",
    );
    const action = request.postDataJSON().action;
    const index = entries.findIndex((e) => e.fulfillmentId === fulfillmentId);
    if (index === -1 || fulfillmentId === "fulfillment_cookie_stale")
      return json(route, 409, { ok: false, error: "order_queue_changed" });
    const entry = entries[index];
    if (action === "start") entry.preparation = "preparing";
    if (action === "ready") {
      entry.stage = "ready";
      entry.since = new Date().toISOString();
      entry.preparation =
        entry.preparation === "not_needed" ? "not_needed" : "completed";
    }
    if (action === "hand_over") entries.splice(index, 1);
    return json(route, 200, { ok: true, action });
  });

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`,
  );

  // 1. The owner makes a pickup board. Its preview shows example codes.
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Pickup");
  await page.locator(`.menu-boards-new input[value="pickup_board:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.locator(".menu-board-pickup").first().waitFor({ timeout: 15_000 });
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  check("the board has two lists of codes",
    (await page.locator(".menu-board-pickup").count()) === 2);
  check("the board has no menu section and no QR code",
    (await page.locator(".menu-board-element-section").count()) === 0 &&
    (await page.locator(".menu-board-element-order_qr").count()) === 0);
  await capture(page, "01-pickup-board-draft");

  // 2. The owner selects the list and sees what it shows.
  await page.locator(".menu-board-element-pickup_codes").first().click();
  const drawer = page.getByRole("complementary", { name: "Selected order codes" });
  await drawer.waitFor();
  check("the drawer names the stage",
    (await selectValue(drawer.getByRole("combobox", { name: "Shows", exact: true }))) === "preparing");
  await drawer.getByRole("button", { name: "Done", exact: true }).click();

  // 3. The owner publishes it and pairs a TV.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Published revision 1.", { exact: false }).first().waitFor({ timeout: 15_000 });
  const tv = await page.context().newPage();
  await tv.setViewportSize({ width: 1280, height: 720 });
  await tv.goto(`${PORTAL}/tv`);
  const codeText = tv.locator(".tv-code");
  await codeText.waitFor({ timeout: 15_000 });
  const code = (await codeText.textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await page.getByRole("button", { name: "Add a screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a screen" });
  await dialog.getByLabel("Code from the screen").fill(code.toLowerCase());
  await dialog.getByLabel("Name", { exact: true }).fill("Pickup TV");
  await dialog.getByRole("button", { name: "Pair screen", exact: true }).click();
  await page.getByText("Pickup TV", { exact: true }).waitFor({ timeout: 15_000 });

  // 4. The TV shows the live codes under each stage.
  const stage = (name) =>
    tv.locator(`.menu-board-pickup[data-stage="${name}"] li`).allTextContents();
  await tv.locator(".menu-board-pickup li", { hasText: "F-062" }).waitFor({ timeout: 30_000 });
  check("the TV shows the orders to prepare",
    JSON.stringify(await stage("preparing")) === JSON.stringify(["F-062", "K-418"]),
    await stage("preparing"));
  check("the TV shows the order to collect",
    JSON.stringify(await stage("ready")) === JSON.stringify(["T-731"]),
    await stage("ready"));
  check("a board with fresh codes shows no offline mark",
    (await tv.locator(".menu-board-unverified").count()) === 0);
  await capture(tv, "02-tv-pickup-board");

  // 5. Staff open the queue on a tablet: what to make, oldest first.
  const queue = await page.context().newPage();
  await queue.setViewportSize({ width: 1024, height: 768 });
  await queue.goto(`${PORTAL}/order-queue-preview.html?organisation=${fixtures.organisationId}`);
  const row = (code) => queue.locator(`.order-queue-row[data-code="${code}"]`);
  await row("F-062").waitFor({ timeout: 15_000 });
  check("the row names what to make",
    /2 ×\s*Taro Milk Tea/u.test((await row("F-062").textContent()) ?? "") &&
    /Oat milk, Less sweet/u.test((await row("F-062").textContent()) ?? ""));
  check("an order from the case has no Start",
    (await row("K-418").getByRole("button", { name: "Start" }).count()) === 0);
  await capture(queue, "03-queue");

  // 6. Staff start the drink, mark it ready and hand over another order.
  await row("F-062").getByRole("button", { name: "Start", exact: true }).click();
  await row("F-062").getByText("Started", { exact: true }).waitFor({ timeout: 10_000 });
  await capture(queue, "04-queue-started");
  await row("F-062").getByRole("button", { name: "Ready", exact: true }).click();
  await row("F-062").getByRole("button", { name: "Hand over", exact: true }).waitFor({ timeout: 10_000 });
  await row("T-731").getByRole("button", { name: "Hand over", exact: true }).click();
  await row("T-731").waitFor({ state: "detached", timeout: 10_000 });
  await capture(queue, "05-queue-after");

  // 7. The TV's next read shows the moves.
  await tv.reload();
  await tv.locator(".menu-board-pickup li", { hasText: "F-062" }).waitFor({ timeout: 30_000 });
  check("the code moved to Ready and the handed-over code left",
    JSON.stringify(await stage("ready")) === JSON.stringify(["F-062"]) &&
    JSON.stringify(await stage("preparing")) === JSON.stringify(["K-418"]),
    { ready: await stage("ready"), preparing: await stage("preparing") });
  await capture(tv, "06-tv-after");

  // 7b. The shop stops answering. The TV keeps the codes and says so.
  await tv.route("**/v1/screens/pickup", (route) =>
    json(route, 503, { ok: false, error: "menu_screen_unavailable" }),
  );
  await tv.evaluate(() => window.dispatchEvent(new Event("online")));
  await tv.locator(".menu-board-unverified").waitFor({ timeout: 15_000 });
  check("the TV keeps the last codes and marks them",
    JSON.stringify(await stage("ready")) === JSON.stringify(["F-062"]));
  await capture(tv, "06b-tv-not-verified");

  // 8. A second tablet's stale click tells the person what happened.
  await queue.route("**/commerce/order-queue/*/advance", (route) =>
    json(route, 409, { ok: false, error: "order_queue_changed" }),
  );
  await row("K-418").getByRole("button", { name: "Ready", exact: true }).click();
  await queue.getByRole("alert").filter({ hasText: "Another screen moved this order." })
    .waitFor({ timeout: 10_000 });
  await capture(queue, "07-queue-refusal");

  // 9. The queue fits a phone, with no sideways scroll.
  await queue.setViewportSize({ width: 390, height: 800 });
  check("the phone layout has no sideways scroll",
    await queue.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await capture(queue, "08-queue-phone");
  return { result: "passed", checks, captures };
}
