async (page) => {
  // Comments pinned to a board's elements (Plan 40B phase 5, slice 6), in
  // two real browsers on one board, against a local Worker with its own D1
  // (the Plan 74 harness).
  //
  // The owner selects the order QR code and comments on it; a pin with the
  // count shows on the element. The admin's browser shows the pin within a
  // few seconds; the admin opens it, replies and resolves the thread, and
  // the pin goes in both browsers. Each person can delete only their own
  // comment. The owner opens the thread again, and the pin returns.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-board-comments.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-comments
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const fixtures = JOURNEY_FIXTURES;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const ASK = "Make the QR code bigger, please.";
  const REPLY = "On it. 440 wide.";
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
  const drawer = (target) => target.getByRole("complementary", { name: "Selected order qr code" });
  // A saved comment, not the text that a person is still typing.
  const saved = (target, text) => drawer(target).locator(".menu-board-comment-thread p", { hasText: text }).first();
  const pin = (target, id) => target.locator(`.menu-board-comment-pin[data-element-id="${id}"]`);

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(boardUrl);
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Comments");
  await page.locator(`.menu-boards-new input[value="canvas_landscape:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  const qrId = await page.locator(".menu-board-canvas-element.menu-board-element-order_qr").getAttribute("data-element-id");

  // 1. The owner comments on the QR code; a pin shows on it.
  await page.locator(`.menu-canvas-hit[data-element-id="${qrId}"]`).click();
  await drawer(page).getByLabel("New comment").fill(ASK);
  await drawer(page).getByRole("button", { name: "Comment", exact: true }).click();
  await saved(page, ASK).waitFor();
  await pin(page, qrId).waitFor();
  check("the pin counts one open thread", (await pin(page, qrId).textContent())?.trim() === "1");
  await capture(page, "01-owner-comment");

  // 2. The admin sees the pin, opens it, replies and resolves the thread.
  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.setViewportSize({ width: 1440, height: 1100 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await other.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await pin(other, qrId).waitFor({ timeout: 10_000 });
  const list = other.getByRole("complementary", { name: "Open comments" });
  check("the admin's board list names the thread", (await list.textContent())?.includes(ASK), await list.textContent());
  await pin(other, qrId).click();
  await saved(other, ASK).waitFor();
  check("the admin cannot delete the owner's comment",
    (await drawer(other).getByRole("button", { name: "Delete", exact: true }).count()) === 0);
  await drawer(other).getByLabel("Reply").fill(REPLY);
  await drawer(other).getByRole("button", { name: "Reply", exact: true }).click();
  await saved(other, REPLY).waitFor();
  check("the admin can delete their own reply",
    (await drawer(other).getByRole("button", { name: "Delete", exact: true }).count()) === 1);
  await capture(other, "02-admin-reply");
  await drawer(other).getByRole("button", { name: "Resolve", exact: true }).click();
  await drawer(other).getByText("Resolved by", { exact: false }).waitFor();
  await pin(other, qrId).waitFor({ state: "detached" });

  // 3. The owner sees the reply and the resolution within a few seconds.
  await saved(page, REPLY).waitFor({ timeout: 10_000 });
  await drawer(page).getByText("Resolved by", { exact: false }).waitFor({ timeout: 10_000 });
  await pin(page, qrId).waitFor({ state: "detached", timeout: 10_000 });
  check("the owner can delete only the owner's comment",
    (await drawer(page).getByRole("button", { name: "Delete", exact: true }).count()) === 1);
  await capture(page, "03-owner-resolved");

  // 4. The owner opens the thread again; the pin returns for the admin.
  await drawer(page).getByRole("button", { name: "Reopen", exact: true }).click();
  await pin(page, qrId).waitFor();
  await pin(other, qrId).waitFor({ timeout: 10_000 });
  await capture(other, "04-admin-pin-again");
  await otherContext.close();
  return { result: "passed", checks, captures };
}
