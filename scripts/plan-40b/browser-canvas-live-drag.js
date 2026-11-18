async (page) => {
  // A drag that other people see while it moves (Plan 40B phase 5, slice 5),
  // in two real browsers on one board, against a local Worker with its own
  // D1 (the Plan 74 harness).
  //
  // The owner drags the order QR code across the free canvas and holds the
  // mouse down. The admin's browser shows the QR code moving, step by step,
  // with the owner's name on it, while the stored board does not change.
  // On release, the board changes once and both browsers show the same
  // place. A resize shows the same way.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-canvas-live-drag.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-live-drag
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
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const boardUrl = `${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`;
  const saved = (target) => target.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  // Where a browser draws an element, in board units.
  const drawn = (target, id) => target.locator(`.menu-board-canvas-element[data-element-id="${id}"]`).evaluate((node) => ({
    x: Number.parseFloat(node.style.left),
    y: Number.parseFloat(node.style.top),
    width: Number.parseFloat(node.style.width),
    height: Number.parseFloat(node.style.height),
  }));
  const revision = (target) => target.evaluate(async (organisationId) => {
    const response = await fetch(`/v1/control/organisations/${encodeURIComponent(organisationId)}/menu-boards`, { credentials: "same-origin" });
    const body = await response.json();
    return body.boards[0].documentRevision;
  }, fixtures.organisationId);
  const until = async (name, read, test, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
      value = await read();
      if (test(value)) return value;
      await pause(50);
    }
    check(name, false, value);
    return value;
  };

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(boardUrl);
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Live drag");
  await page.locator(`.menu-boards-new input[value="canvas_landscape:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await saved(page);
  const qrId = await page.locator(".menu-board-canvas-element.menu-board-element-order_qr").getAttribute("data-element-id");

  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.setViewportSize({ width: 1440, height: 1000 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await other.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await saved(other);
  const start = await drawn(other, qrId);
  check("both browsers start with the same place", JSON.stringify(start) === JSON.stringify(await drawn(page, qrId)), start);
  const before = await revision(page);

  // 1. The owner drags the QR code to the left and holds the mouse down.
  const hit = page.locator(`.menu-canvas-hit[data-element-id="${qrId}"]`);
  const box = await hit.boundingBox();
  const grab = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  const seen = [];
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(grab.x - step * 40, grab.y - step * 10);
    await pause(120);
    seen.push((await drawn(other, qrId)).x);
  }
  const midway = await until(
    "the admin sees the QR code move before the release",
    () => drawn(other, qrId),
    (rect) => rect.x < start.x - 150,
  );
  const marker = other.locator(`.menu-canvas-remote-selection[data-moving="true"]`);
  check("the moving element carries the owner's name", (await marker.getAttribute("data-participant")) === "Owner");
  check("the admin saw the drag in several steps", new Set(seen.filter((x) => x < start.x)).size >= 3, seen);
  check("the stored board has not changed during the drag", (await revision(page)) === before);
  await capture(other, "01-admin-sees-drag");

  // 2. The release writes the board once; both browsers show the same place.
  await page.mouse.up();
  await saved(page);
  const placed = await drawn(page, qrId);
  await until("the admin shows the released place", () => drawn(other, qrId), (rect) => JSON.stringify(rect) === JSON.stringify(placed));
  await until("the moving mark ends", () => marker.count(), (count) => count === 0);
  check("the release moved the QR code left", placed.x < midway.x + 1 && placed.x < start.x - 150, { placed, midway });
  check("the release is one board edit", (await revision(page)) === before + 1, { before, after: await revision(page) });
  await capture(other, "02-admin-after-release");

  // 3. A resize shows while it moves, too.
  const handle = page.locator(".menu-canvas-handle[data-handle='se']");
  const corner = await handle.boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 5; step += 1) {
    await page.mouse.move(corner.x + step * 30, corner.y + step * 12);
    await pause(100);
  }
  const growing = await until("the admin sees the QR code grow", () => drawn(other, qrId), (rect) => rect.width > placed.width + 80);
  check("the stored board has not changed during the resize", (await revision(page)) === before + 1);
  await capture(other, "03-admin-sees-resize");
  await page.mouse.up();
  await saved(page);
  const resized = await drawn(page, qrId);
  await until("both browsers show the new size", () => drawn(other, qrId), (rect) => JSON.stringify(rect) === JSON.stringify(resized));
  check("the resize kept the left edge", resized.x === placed.x && resized.width > placed.width, { placed, resized, growing });
  await otherContext.close();
  return {
    result: "passed",
    checks,
    captures,
    drag: { stepsSeen: new Set(seen).size, releasedEdits: 1 },
  };
}
