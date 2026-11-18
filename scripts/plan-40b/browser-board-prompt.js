async (page) => {
  // Prompt to edit from a selected element (Plan 40B phase 5, slice 9), the
  // Portal half, against a local Worker with its own D1 (the Plan 74
  // harness). The E2E journey `pi-menu-board-prompt.test.ts` proves the
  // agent half: the model reads the selection from the page, the first
  // write waits for the owner's permission, and the board changes.
  //
  // The owner selects a text and asks Sous Chef to change it. The chat request
  // that the browser sends carries the Boards page with that selection. A
  // second person then changes the text in the room, as the agent's edit
  // arrives; the owner's panel names the changed element and undoes it as
  // the owner's own edit, and "Bring the change back" returns it. This harness runs
  // no agent turn: its Worker has no model exit, so the turn itself fails.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-board-prompt.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-prompt
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const fixtures = JOURNEY_FIXTURES;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const ASK = "Make it say that oat milk is free today";
  const BEFORE = "Soy milk +¥50";
  const AFTER = "Oat milk is free today";
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
  const shown = (target) => target.locator(".menu-board .menu-board-text").first().textContent();
  const until = async (name, read, expected, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
      value = await read();
      if (value === expected) return value;
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
  await page.getByLabel("Name", { exact: true }).fill("Prompt");
  await page.locator(`.menu-boards-new input[value="canvas_landscape:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  const before = new Set(await page.locator(".menu-canvas-hit").evaluateAll((hits) => hits.map((hit) => hit.dataset.elementId)));
  await page.getByRole("combobox", { name: "Add", exact: true }).click();
  await page.getByRole("option", { name: "Text", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Selected text" });
  await drawer.getByLabel("Text", { exact: true }).fill(BEFORE);
  await saved(page);
  const textId = (await page.locator(".menu-canvas-hit").evaluateAll((hits) => hits.map((hit) => hit.dataset.elementId)))
    .find((id) => !before.has(id));

  // 1. The owner asks Sous Chef; the chat request carries the page and selection.
  const panel = drawer.getByRole("region", { name: "Ask the agent" });
  await panel.getByLabel("Ask Sous Chef to change this element").fill(ASK);
  const sent = page.waitForRequest((request) => request.method() === "POST" && /\/chat$/u.test(new URL(request.url()).pathname));
  await panel.getByRole("button", { name: "Ask Sous Chef", exact: true }).click();
  const request = await sent;
  const command = JSON.parse(request.postData() ?? "{}");
  const view = command.pageView ?? {};
  const selected = (view.sections ?? []).find((section) => section.title === "Selected elements");
  check("the message holds the person's words", typeof command.text === "string" && command.text.startsWith(ASK), command.text);
  check("the message carries the Boards page", view.page === "menu-boards", view.page);
  check("the page names the selected text and its words",
    JSON.stringify(selected?.table?.rows?.[0]?.slice(0, 3)) === JSON.stringify([textId, "Text", `text: ${BEFORE}`]),
    selected?.table?.rows);
  await capture(page, "01-asked");

  // 2. The text changes in the room, as the agent's edit arrives.
  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.setViewportSize({ width: 1440, height: 1100 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await other.locator(`.menu-canvas-hit[data-element-id="${textId}"]`).click({ timeout: 15_000 });
  await other.getByRole("complementary", { name: "Selected text" }).getByLabel("Text", { exact: true }).fill(AFTER);
  await saved(other);
  await until("the owner's board shows the change", () => shown(page), AFTER);
  await panel.getByText("Changed since you asked: Text.", { exact: true }).waitFor({ timeout: 10_000 });
  await capture(page, "02-changed");

  // 3. Undo puts the owner's words back in both browsers; "Bring the change
  // back" returns them.
  await panel.getByRole("button", { name: "Undo these changes", exact: true }).click();
  await until("Undo puts the text back", () => shown(page), BEFORE);
  await until("the other browser follows", () => shown(other), BEFORE);
  await panel.getByRole("button", { name: "Bring the change back", exact: true }).click();
  await until("the change comes back", () => shown(other), AFTER);
  await capture(page, "03-redo");
  await otherContext.close();
  return { result: "passed", checks, captures, pageView: { page: view.page, sections: (view.sections ?? []).map((section) => section.title) } };
}
