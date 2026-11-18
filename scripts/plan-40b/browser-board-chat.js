async (page) => {
  // The board canvas beside the chat (Plan 40B), against a local Worker with
  // its own D1 (the Plan 74 harness). The Portal's Ask link moves to the
  // chat route and names the page beside the chat in the router state; this
  // journey makes the same move on the preview's router. The same canvas
  // stays while the chat opens and closes and while a sheet opens over it, and the canvas
  // fits the narrower pane instead of leaving the page.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-board-chat.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-chat
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
  const capture = async (name) => {
    await page.screenshot({ path: `${ARTIFACTS}/${name}.png` });
    captures.push(`${name}.png`);
  };
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
  const MENUS = "/portal/kitchen/cafe/menus";
  const CHAT = "/portal/kitchen/cafe/chat";
  const move = (to, state) => page.evaluate(([path, routeState]) =>
    window.menusPreviewRouter.navigate(path, routeState === null ? undefined : { state: routeState }), [to, state]);
  const frameWidth = () => page.locator(".menu-board-stage .menu-board-frame").evaluate((node) => Math.round(node.getBoundingClientRect().width));
  const sameCanvas = () => page.evaluate(() => document.querySelector(".menu-board-viewport")?.dataset.journeyMark === "first");
  // The canvas is the Menus page: no sheet over it means the canvas shows.
  // A sheet is the Portal's side drawer, a modal dialog named by its title.
  const sheetDrawer = page.locator("dialog.menu-board-sheet-drawer[open]");
  const openSheet = () => sheetDrawer.locator(".side-drawer-header h2").textContent().catch(() => null);
  const canvasShown = async () => (await page.locator(".menu-board-viewport").count()) === 1 &&
    (await sheetDrawer.count()) === 0;

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`);
  const start = page.locator(".menu-board-start");
  await start.waitFor({ timeout: 15_000 });
  await start.locator('input[value="canvas_landscape:espresso_bar"]').check();
  await start.getByRole("button", { name: "Create board", exact: true }).click();
  await start.waitFor({ state: "detached", timeout: 15_000 });
  await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await page.locator(".menu-board-viewport").evaluate((node) => { node.dataset.journeyMark = "first"; });
  const wide = await frameWidth();
  await capture("01-board");

  // 1. The chat opens beside the page, as the Ask link opens it.
  await move(CHAT, { chatReturnPath: `${MENUS}?tab=boards` });
  check("the canvas stays open with the chat", await canvasShown());
  check("the same canvas stays on screen", await sameCanvas());

  // 2. The chat takes room: the pane narrows and the canvas fits it.
  await page.locator("main.portal-main").evaluate((node) => { node.style.width = "960px"; });
  const narrow = await until("the board fits the narrower pane", frameWidth, (width) => width < wide - 100);
  check("the canvas is still the same canvas", await sameCanvas());
  await capture("02-beside-chat");

  // 3. The Screens sheet opens over the canvas with the chat open: the chat
  // route stays, and the canvas under the sheet is still the same canvas.
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await until("Screens opens beside the chat", openSheet, (label) => label === "Screens");
  check("the chat route stays", await page.evaluate(() => window.menusPreviewRouter.state.location.pathname) === CHAT);
  check("the canvas stays under the sheet", await sameCanvas());
  await capture("02b-screens-sheet");
  await page.getByRole("dialog", { name: "Screens" }).getByRole("button", { name: "Close", exact: true }).click();
  await until("the sheet closes", () => sheetDrawer.count(), (count) => count === 0);
  check("the address no longer names a sheet", await page.evaluate(() => window.menusPreviewRouter.state.location.state?.chatReturnPath) === "/portal/kitchen/cafe/menus");
  check("the canvas after the sheet is the same canvas", await sameCanvas());

  // 4. The chat closes: the pane widens, and the same canvas fits it again.
  await move(`${MENUS}?tab=boards`, null);
  await page.locator("main.portal-main").evaluate((node) => { node.style.width = ""; });
  await until("the board fits the wide pane again", frameWidth, (width) => width > narrow + 100);
  check("the canvas stays when the chat closes", await sameCanvas());
  check("the canvas shows when the chat closes", await canvasShown());
  await capture("03-chat-closed");
  return { result: "passed", checks, captures, widths: { wide, narrow } };
}
