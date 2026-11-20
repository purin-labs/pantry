async (page) => {
  // Board removal and image delete in the board editor (Plan 40B), in a
  // real browser against a local Worker with its own D1 (the Plan 74
  // harness). The archive and restore go through the real Worker routes.
  //
  // The owner makes two boards, archives one and restores it from the
  // Archived list. With every board archived, the start screen shows and the
  // Archived list still restores. In the Images panel, a delete asks a second
  // time and names the board that shows the image.
  //
  // Run: python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-board-archive.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-archive
  //
  // The harness Worker has no shop, so this browser answers the shop's image
  // list and the image delete; pi-menu-board-archive.test.ts proves those
  // routes against Commerce.
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
  const boardUrl = `${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`;
  const base = `/v1/control/organisations/${encodeURIComponent(fixtures.organisationId)}/commerce/media/content/`;
  const IMAGE = { mediaId: "media_" + "c".repeat(32), altText: "Window bake" };
  const deletes = [];
  await page.context().route("**/commerce/media", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, mediaBase: base, images: [{ ...IMAGE, url: `${base}${IMAGE.mediaId}` }] }) })
    : route.continue());
  await page.context().route("**/commerce/media/content/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c58b4e"/></svg>',
  }));
  await page.context().route("**/commerce/media/delete", async (route) => {
    deletes.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "media_on_board", boards: ["Window"] }) });
  });

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(boardUrl);
  const make = async (name) => {
    const start = page.locator(".menu-board-start");
    await start.waitFor({ timeout: 15_000 });
    await start.locator('input[value="canvas_landscape:blank"]').check();
    await start.getByLabel("Name", { exact: true }).fill(name);
    await start.getByRole("button", { name: "Create board", exact: true }).click();
    await start.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  };
  await make("Window");
  await page.getByRole("button", { name: "New board", exact: true }).first().click();
  await make("Counter");
  const chips = page.getByRole("group", { name: "Boards" }).getByRole("button");
  const titles = async () => (await chips.allTextContents()).map((text) => text.replace(/\d+ screens?$/u, "").trim());
  await until("both boards are listed", titles, (list) => list.includes("Window") && list.includes("Counter"));

  // 1. Archive the open board; it moves to the Archived list.
  await chips.filter({ hasText: "Counter" }).click();
  await page.getByRole("button", { name: "Archive Counter", exact: true }).click();
  const archived = page.getByRole("region", { name: "Archived boards" });
  await archived.waitFor({ timeout: 15_000 });
  await until("only Window stays in the board list", titles, (list) => list.length === 1 && list[0] === "Window");
  check("Counter is in the Archived list", (await archived.getByText("Counter", { exact: true }).count()) === 1);
  await capture("01-archived");

  // 2. Restore it: it comes back and opens.
  await archived.getByRole("button", { name: "Restore Counter", exact: true }).click();
  await until("Counter is back in the board list", titles, (list) => list.includes("Counter"));
  await until("the restored board opens", () => chips.filter({ hasText: "Counter" }).getAttribute("aria-pressed"), (value) => value === "true");
  check("the Archived list is gone", (await page.getByRole("region", { name: "Archived boards" }).count()) === 0);

  // 3. Archive both: the start screen shows, and Restore still works.
  for (const name of ["Counter", "Window"]) {
    await chips.filter({ hasText: name }).click();
    await page.getByRole("button", { name: `Archive ${name}`, exact: true }).click();
    await until(`${name} leaves the board list`, titles, (list) => !list.includes(name));
  }
  await page.locator(".menu-board-start").waitFor({ timeout: 15_000 });
  await capture("02-all-archived");
  await page.getByRole("region", { name: "Archived boards" }).getByRole("button", { name: "Restore Window", exact: true }).click();
  await page.locator(".menu-board-start").waitFor({ state: "detached", timeout: 15_000 });
  await until("Window is back", titles, (list) => list.length === 1 && list[0] === "Window");

  // 4. An image delete asks a second time, and the refusal names the board.
  await page.getByRole("tab", { name: "Images", exact: true }).click();
  const panel = page.getByRole("region", { name: "Images" });
  await panel.getByRole("button", { name: "Delete Window bake from the shop", exact: true }).click();
  const confirm = panel.getByRole("group", { name: "Delete this image?" });
  await confirm.waitFor();
  check("nothing is deleted before the second click", deletes.length === 0, deletes);
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await panel.getByText("A board shows this image: Window. Take it off the board first.", { exact: true }).waitFor({ timeout: 15_000 });
  check("the delete sent the image", deletes.length === 1 && deletes[0]?.mediaId === IMAGE.mediaId, deletes);
  await capture("03-image-on-board");
  return { result: "passed", checks, captures, deletes };
}
