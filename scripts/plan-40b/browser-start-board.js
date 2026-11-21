async (page) => {
  // The start screen of a new board (Plan 40B), against a local Worker with
  // its own D1 (the Plan 74 harness).
  //
  // A shop with no board opens on the start screen, with the Menu items and
  // Screens buttons and no Cancel, and with no screen step: every start is a landscape board
  // that the screen guides fit to other screens. The owner picks the Matcha
  // design: the board is a free canvas in the Matcha colours. From New
  // board the owner then makes a blank canvas, which has no element, and a
  // Cancel leaves the boards as they were.
  //
  // Run: python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-start-board.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-start
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

  const start = page.locator(".menu-board-start");
  const layout = () => selectValue(page.getByRole("combobox", { name: "Layout", exact: true }));
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
  const background = () => page.locator(".menu-board").first().evaluate((node) => getComputedStyle(node).backgroundColor);

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`);

  // 1. No board yet: the start screen opens by itself.
  await start.waitFor({ timeout: 15_000 });
  check("a shop with no board has no Cancel", (await start.getByRole("button", { name: "Cancel", exact: true }).count()) === 0);
  check("the start screen keeps the Menu items and Screens buttons",
    await start.getByRole("button", { name: "Menu items", exact: true }).isVisible() &&
      await start.getByRole("button", { name: "Screens", exact: true }).isVisible());
  check("the start screen has no screen step", (await start.getByText("Screen", { exact: true }).count()) === 0 &&
    (await start.locator('input[name="menu-board-shape"]').count()) === 0);
  await capture("01-start");

  // 2. The Matcha design.
  await start.locator('input[value="canvas_landscape:matcha_bar"]').check();
  await start.getByLabel("Name", { exact: true }).fill("Window");
  check("the summary names the choice", (await start.locator(".menu-board-start-summary").textContent()) === "Matcha");
  await capture("02-matcha");
  await start.getByRole("button", { name: "Create board", exact: true }).click();
  await start.waitFor({ state: "detached", timeout: 15_000 });
  await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await until("the board is a free canvas", layout, "canvas_landscape");
  checks.push({ name: "the board is a free canvas", passed: true });
  check("the board has the Matcha background", (await background()) === "rgb(29, 43, 31)", await background());
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await capture("03-matcha-board");

  // 3. New board: a blank canvas.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await start.waitFor();
  check("New board offers Cancel", await start.getByRole("button", { name: "Cancel", exact: true }).isVisible());
  await start.locator('input[value="canvas_landscape:blank"]').check();
  await start.getByLabel("Name", { exact: true }).fill("Table");
  await start.getByRole("button", { name: "Create board", exact: true }).click();
  await start.waitFor({ state: "detached", timeout: 15_000 });
  await page.getByRole("button", { name: /^Table/u, pressed: true }).waitFor({ timeout: 15_000 });
  // The new board's room connects; then its toolbar names its layout.
  await until("the blank board is a canvas", layout, "canvas_landscape");
  await until("the blank canvas has no element", () => page.locator(".menu-canvas-hit").count(), 0);
  checks.push({ name: "the blank board is a canvas", passed: true });
  checks.push({ name: "the blank canvas has no element", passed: true });

  // 4. Cancel leaves the boards as they were.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await start.getByRole("button", { name: "Cancel", exact: true }).click();
  await start.waitFor({ state: "detached" });
  const boards = await page.locator(".menu-boards-chips button").count();
  check("two boards, and no third", boards === 2, boards);
  await capture("04-blank");
  return { result: "passed", checks, captures };
}
