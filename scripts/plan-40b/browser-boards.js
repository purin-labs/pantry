async (page) => {
  // Menus › Boards and Menus › Screens in a browser (Plan 40B phase 1),
  // against a local Worker with its own D1 (the Plan 74 harness).
  //
  // The owner makes a drinks board from the three-column layout, changes its
  // title in the side drawer, and publishes it. A TV then opens /tv in a
  // second tab and shows a code; the owner pairs it in the Screens tab, and
  // the TV plays the published board. This shop has no Commerce merchant,
  // so the board shows no prices and marks them not verified.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-boards.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-portal
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

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`,
  );

  // 1. The owner makes a board from a layout.
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Drinks");
  await page.locator(`.menu-boards-new input[value="three_columns:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  const chip = page.getByRole("button", { name: /^Drinks/u });
  await chip.waitFor({ timeout: 15_000 });
  check("the new board is selected", (await chip.getAttribute("aria-pressed")) === "true");
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await page.locator(".menu-board-element-order_qr").waitFor();
  check("the template has a heading and the order QR code",
    (await page.locator(".menu-board-element-heading").count()) === 1 &&
    (await page.locator(".menu-board-element-order_qr").count()) === 1);
  await capture(page, "01-new-board");

  // 2. The owner selects the heading and changes its title in the drawer.
  await page.locator(".menu-board-element-heading").click();
  const drawer = page.getByRole("complementary", { name: "Selected heading" });
  await drawer.waitFor();
  await drawer.getByLabel("Title", { exact: true }).fill("Coffee & tea");
  await page.locator(".menu-board h1", { hasText: "Coffee & tea" }).waitFor();
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await capture(page, "02-drawer");

  // 3. The owner publishes the board.
  await drawer.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Published revision 1.", { exact: false }).first().waitFor({ timeout: 15_000 });
  await capture(page, "03-published");

  // 4. A TV opens /tv and shows its code; the owner pairs it.
  const tv = await page.context().newPage();
  await tv.setViewportSize({ width: 1280, height: 720 });
  await tv.goto(`${PORTAL}/tv`);
  const codeText = tv.locator(".tv-code");
  await codeText.waitFor({ timeout: 15_000 });
  const code = (await codeText.textContent())?.trim() ?? "";
  check("the TV shows a six-letter code", /^[A-HJ-NP-Z2-9]{6}$/u.test(code), code);
  await capture(tv, "04-tv-code");
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await page.getByRole("button", { name: "Add a screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a screen" });
  await dialog.getByLabel("Code from the screen").fill(code.toLowerCase());
  await dialog.getByLabel("Name", { exact: true }).fill("Counter TV");
  await capture(page, "05-pair-dialog");
  await dialog.getByRole("button", { name: "Pair screen", exact: true }).click();
  await page.getByText("Counter TV", { exact: true }).waitFor({ timeout: 15_000 });

  // 5. The TV plays the published board.
  await tv.locator(".menu-board h1", { hasText: "Coffee & tea" }).waitFor({ timeout: 30_000 });
  // With no order page, the QR card keeps its place without a code.
  check("the TV plays the published board", (await tv.locator(".menu-board-element-order_qr").count()) === 1);
  await capture(tv, "06-tv-playing");
  await page.reload();
  await page.getByRole("button", { name: "Screens", exact: true }).click().catch(() => undefined);
  await page.getByText("Live now", { exact: true }).waitFor({ timeout: 30_000 });
  await capture(page, "07-screens");
  return { result: "passed", checks, captures };
}
