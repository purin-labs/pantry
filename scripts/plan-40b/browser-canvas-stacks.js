async (page) => {
  // Auto-layout stacks on the free canvas (Plan 40B phase 5, slice 8), in
  // two real browsers on one board, against a local Worker with its own D1
  // (the Plan 74 harness).
  //
  // The owner adds two texts, selects both and makes a stack. A wider gap
  // and a taller first text move the second text; a drag of a text moves
  // the whole stack. The admin's browser shows the same places. Undo takes
  // back the drag, and Unstack leaves both texts where the stack showed
  // them.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-canvas-stacks.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-stacks
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
  const drawn = (target, id) => target.locator(`.menu-board-canvas-element[data-element-id="${id}"]`).evaluate((node) => ({
    x: Number.parseFloat(node.style.left),
    y: Number.parseFloat(node.style.top),
    width: Number.parseFloat(node.style.width),
    height: Number.parseFloat(node.style.height),
  }));
  const until = async (name, read, test, timeout = 10_000) => {
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
  const ids = (target) => target.locator(".menu-canvas-hit").evaluateAll((hits) => hits.map((hit) => hit.dataset.elementId));

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(boardUrl);
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Stacks");
  await page.locator(`.menu-boards-new input[value="canvas_landscape:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await saved(page);

  // 1. The owner adds two texts, one below the other.
  const texts = [];
  for (const [words, presses] of [["Soup of the day", 30], ["Bread basket", 0]]) {
    const before = new Set(await ids(page));
    await page.getByRole("combobox", { name: "Add", exact: true }).click();
  await page.getByRole("option", { name: "Text", exact: true }).click();
    await page.getByRole("complementary", { name: "Selected text" }).getByLabel("Text", { exact: true }).fill(words);
    const id = (await ids(page)).find((candidate) => !before.has(candidate));
    texts.push(id);
    await page.locator(`.menu-canvas-hit[data-element-id="${id}"]`).click();
    for (let index = 0; index < presses; index += 1) await page.keyboard.press("Shift+ArrowUp");
  }
  await saved(page);

  // 2. The owner selects both and makes a stack.
  await page.locator(`.menu-canvas-hit[data-element-id="${texts[0]}"]`).click();
  await page.locator(`.menu-canvas-hit[data-element-id="${texts[1]}"]`).click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Stack down", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Selected stack" });
  await drawer.waitFor();
  await saved(page);
  const layers = await page.locator(".menu-canvas-layers li").evaluateAll((items) =>
    items.map((item) => [item.dataset.inStack === "true", item.querySelector(".menu-canvas-layer-name")?.textContent]));
  check("the layers list shows the stack with its two texts under it",
    JSON.stringify(layers.filter(([, name]) => name === "Stack" || name === "Text")) ===
      JSON.stringify([[false, "Stack"], [true, "Text"], [true, "Text"]]), layers);
  await capture(page, "01-stack-made");

  // 3. A wider gap moves the second text.
  await drawer.getByLabel("Gap", { exact: true }).fill("48");
  const gapped = await until("the gap is 48", async () => {
    const [first, second] = [await drawn(page, texts[0]), await drawn(page, texts[1])];
    return second.y - (first.y + first.height);
  }, (gap) => gap === 48);
  check("the stack keeps its texts in order with the gap", gapped === 48);

  // 4. A taller first text moves the second one down.
  await page.locator(`.menu-canvas-hit[data-element-id="${texts[0]}"]`).click();
  const child = page.getByRole("complementary", { name: "Selected text" });
  await child.getByText("In a stack", { exact: true }).waitFor();
  const secondBefore = await drawn(page, texts[1]);
  const firstBefore = await drawn(page, texts[0]);
  await child.getByLabel("Height", { exact: true }).fill(String(firstBefore.height + 100));
  await until("the second text moves down by the growth", () => drawn(page, texts[1]), (rect) => rect.y === secondBefore.y + 100);
  await saved(page);

  // 5. The admin's browser shows the same places.
  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.setViewportSize({ width: 1440, height: 1100 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await other.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  const placed = [await drawn(page, texts[0]), await drawn(page, texts[1])];
  await until("the admin sees the stacked texts", async () => [await drawn(other, texts[0]), await drawn(other, texts[1])],
    (rects) => JSON.stringify(rects) === JSON.stringify(placed));
  await capture(other, "02-admin-stack");

  // 6. A drag of the first text moves the whole stack.
  const hit = await page.locator(`.menu-canvas-hit[data-element-id="${texts[0]}"]`).boundingBox();
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.mouse.down();
  await page.mouse.move(hit.x + hit.width / 2 + 120, hit.y + hit.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await saved(page);
  const dragged = [await drawn(page, texts[0]), await drawn(page, texts[1])];
  const dx = dragged[0].x - placed[0].x;
  const dy = dragged[0].y - placed[0].y;
  check("both texts moved by the same distance", dx !== 0 && dragged[1].x - placed[1].x === dx && dragged[1].y - placed[1].y === dy, { placed, dragged });
  check("the texts kept their sizes", dragged[0].height === placed[0].height && dragged[1].height === placed[1].height);
  await until("the admin sees the moved stack", () => drawn(other, texts[1]), (rect) => JSON.stringify(rect) === JSON.stringify(dragged[1]));
  await capture(other, "03-admin-dragged");

  // 7. Undo takes back the drag in both browsers.
  await page.locator(".menu-canvas").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await until("Undo returns the stack", () => drawn(other, texts[1]), (rect) => JSON.stringify(rect) === JSON.stringify(placed[1]));

  // 8. Unstack leaves both texts where the stack showed them.
  await page.locator(".menu-canvas-layers li button", { hasText: "Down · gap" }).click();
  await drawer.getByRole("button", { name: "Unstack", exact: true }).click();
  await saved(page);
  await until("the texts stay where they were", async () => [await drawn(page, texts[0]), await drawn(page, texts[1])],
    (rects) => JSON.stringify(rects) === JSON.stringify(placed));
  check("the layers list has no stack", (await page.locator(".menu-canvas-layers li[data-in-stack='true']").count()) === 0 &&
    (await page.locator(".menu-canvas-layer-name", { hasText: /^Stack$/u }).count()) === 0);
  await until("the admin sees the texts on the canvas", () => other.locator(".menu-canvas-layers li[data-in-stack='true']").count(), (count) => count === 0);
  await capture(other, "04-admin-unstacked");
  await otherContext.close();
  return { result: "passed", checks, captures };
}
