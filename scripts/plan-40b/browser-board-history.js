async (page) => {
  // Version history with restore (Plan 40B phase 5, slice 7), in two real
  // browsers on one board, against a local Worker with its own D1 (the
  // Plan 74 harness).
  //
  // The owner names the board as it is. The admin, in a second browser,
  // adds a text and the owner retitles the heading. The owner opens History
  // and restores the named version: both browsers drop the text and show
  // the first title at once, with no reload. The owner restores "Before a
  // restore", and both browsers show the later board again.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-board-history.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-history
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
  const boardUrl = `${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`;
  const saved = (target) => target.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  const title = (target) => target.locator(".menu-board h1").first().textContent();
  const texts = (target) => target.locator(".menu-board .menu-board-text").allTextContents();
  const until = async (name, read, expected, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
      value = await read();
      if (JSON.stringify(value) === JSON.stringify(expected)) return value;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    check(name, false, { expected, got: value });
    return value;
  };

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(boardUrl);
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("History");
  await page.locator(`.menu-boards-new input[value="canvas_landscape:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await saved(page);

  // 1. The owner names the board as it is.
  await page.getByRole("button", { name: "History", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Board history" });
  await panel.getByLabel("Name this version").fill("Opening look");
  await panel.getByRole("button", { name: "Save version", exact: true }).click();
  await panel.getByText("Opening look", { exact: true }).waitFor();
  check("the history lists the named version and the new board",
    (await panel.locator("li").allTextContents()).map((text) => text.split(/\d/u)[0]).join("|").includes("Opening look"));
  await panel.getByRole("button", { name: "Done", exact: true }).click();

  // 2. The admin adds a text; the owner retitles the heading.
  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.setViewportSize({ width: 1440, height: 1100 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await other.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await saved(other);
  await other.getByRole("combobox", { name: "Add", exact: true }).click();
  await other.getByRole("option", { name: "Text", exact: true }).click();
  await other.getByRole("complementary", { name: "Selected text" }).getByLabel("Text", { exact: true }).fill("Soup of the day");
  await saved(other);
  await page.locator(".menu-board-canvas-element.menu-board-element-heading").evaluate((node) => node.dataset.elementId)
    .then((id) => page.locator(`.menu-canvas-hit[data-element-id="${id}"]`).click());
  await page.getByRole("complementary", { name: "Selected heading" }).getByLabel("Title", { exact: true }).fill("Lunch");
  await saved(page);
  await until("the admin sees the owner's title", () => title(other), "Lunch");
  await until("the owner sees the admin's text", () => texts(page), ["Soup of the day"]);
  await capture(other, "01-admin-before-restore");

  // 3. The owner restores the named version; both browsers follow at once.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await panel.getByRole("button", { name: "Restore Opening look", exact: true }).click();
  await panel.getByText("Restored “Opening look”", { exact: false }).waitFor({ timeout: 15_000 });
  await until("the owner's board shows the named version", async () => [await title(page), await texts(page)], ["History", []]);
  await until("the admin's board follows with no reload", async () => [await title(other), await texts(other)], ["History", []]);
  check("the restore saved the board before it", (await panel.locator("li").first().textContent())?.startsWith("Before a restore"));
  await capture(page, "02-owner-restored");
  await capture(other, "03-admin-restored");

  // 4. Restoring "Before a restore" undoes the restore in both browsers.
  await panel.getByRole("button", { name: "Restore Before a restore", exact: true }).first().click();
  await panel.getByText("Restored “Before a restore”", { exact: false }).waitFor({ timeout: 15_000 });
  await until("the owner's board is back", async () => [await title(page), await texts(page)], ["Lunch", ["Soup of the day"]]);
  await until("the admin's board is back", async () => [await title(other), await texts(other)], ["Lunch", ["Soup of the day"]]);
  await capture(other, "04-admin-undone");
  await otherContext.close();
  return { result: "passed", checks, captures };
}
