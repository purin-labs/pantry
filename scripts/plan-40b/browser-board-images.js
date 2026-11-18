async (page) => {
  // The Images panel of the board editor (Plan 40B, the image element), in
  // two real browsers on one board, against a local Worker with its own D1
  // (the Plan 74 harness).
  //
  // The owner uploads an image in the Images tab, drags it onto a free
  // canvas and sets it to fit inside its rect with its own alt text; the
  // admin's browser shows the same image. The owner publishes, and a paired
  // TV loads the image from the address that the release names.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-board-images.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-images
  //
  // The harness Worker has no shop, so this browser answers the shop's
  // image list, the upload and the image bytes, and records the upload. The
  // E2E journey services/platform/tests/e2e/pi-menu-board-image.test.ts
  // proves those routes, the release address and the public screen route.
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
  const SHELF = { mediaId: "media_" + "a".repeat(32), altText: "Shelf of loaves" };
  const BAKE = { mediaId: "media_" + "b".repeat(32), altText: "morning bake" };
  const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${fill}"/><circle cx="200" cy="150" r="90" fill="#f4ead8"/></svg>`;
  const library = [SHELF];
  const uploads = [];
  const imageLoaded = (image) => image.evaluate((element) => element.complete && element.naturalWidth > 0);

  await page.context().route("**/commerce/media", (route) => route.request().method() === "GET"
    ? route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, mediaBase: base, images: library.map((image) => ({ ...image, url: `${base}${image.mediaId}` })) }),
    })
    : route.continue());
  await page.context().route("**/commerce/media/add", async (route) => {
    const form = route.request().postData() ?? "";
    uploads.push({ hasFile: form.includes("morning-bake.png"), altText: /name="altText"\r\n\r\n([^\r]*)/u.exec(form)?.[1] ?? null });
    library.push(BAKE);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, mediaId: BAKE.mediaId }) });
  });
  await page.context().route("**/commerce/media/content/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg(route.request().url().endsWith(BAKE.mediaId) ? "#c58b4e" : "#7d9a6b") }));

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(boardUrl);
  const start = page.locator(".menu-board-start");
  await start.waitFor({ timeout: 15_000 });
  await start.locator('input[value="canvas_landscape:blank"]').check();
  await start.getByLabel("Name", { exact: true }).fill("Window");
  await start.getByRole("button", { name: "Create board", exact: true }).click();
  await start.waitFor({ state: "detached", timeout: 15_000 });
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });

  // 1. The Images tab lists the shop's images; an upload adds one.
  await page.getByRole("tab", { name: "Images", exact: true }).click();
  const panel = page.getByRole("region", { name: "Images" });
  const tiles = panel.locator(".menu-board-image-tile");
  await until("the panel lists the shop's image", () => tiles.count(), (count) => count === 1);
  await panel.getByLabel("Image file").setInputFiles({ name: "morning-bake.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]) });
  await until("the upload shows in the panel", () => tiles.count(), (count) => count === 2);
  check("the upload sent the file and a name from it", uploads.length === 1 && uploads[0].hasFile && uploads[0].altText === "morning bake", uploads);
  check("the panel shows the uploaded image", await until("the tile image loads", () => imageLoaded(tiles.nth(1).locator("img")), Boolean));
  await capture(page, "01-images");

  // 2. A drag onto the canvas places the image.
  const images = (target) => target.locator(".menu-board-canvas-element.menu-board-element-image img.menu-board-image");
  const frame = await page.locator(".menu-board-stage .menu-board-frame").boundingBox();
  const viewport = await page.locator(".menu-board-viewport").boundingBox();
  await tiles.nth(1).dragTo(page.locator(".menu-board-viewport"), {
    targetPosition: { x: frame.x + frame.width * 0.6 - viewport.x, y: frame.y + frame.height * 0.45 - viewport.y },
  });
  await until("the image shows on the board", () => images(page).count(), (count) => count === 1);
  check("the board image loads", await until("the board image loads", () => imageLoaded(images(page).first()), Boolean));
  const drawer = page.getByRole("complementary", { name: "Selected image" });
  await drawer.waitFor();

  // 3. The inspector sets the fit and the alt text; the admin sees both.
  await drawer.getByRole("group", { name: "Fit" }).getByRole("button", { name: "Fit inside", exact: true }).click();
  await drawer.getByLabel("What the image shows").fill("Morning bake on the counter");
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.route("**/commerce/media", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, mediaBase: base, images: library.map((image) => ({ ...image, url: `${base}${image.mediaId}` })) }),
  }));
  await other.route("**/commerce/media/content/**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg("#c58b4e") }));
  await other.setViewportSize({ width: 1440, height: 1000 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await until("the admin sees the image", () => images(other).count(), (count) => count === 1);
  await until("the admin sees it fit inside", () => images(other).first().getAttribute("data-fit"), (fit) => fit === "contain");
  check("the admin sees the new alt text", (await images(other).first().getAttribute("alt")) === "Morning bake on the counter");
  await capture(page, "02-placed");

  // 4. A paired TV loads the image from the address that the release names;
  // an edit after the publish turns Publish on again.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Published revision 1.", { exact: false }).first().waitFor({ timeout: 15_000 });
  // An edit after the publish turns Publish on again, with no reload.
  const publishButton = page.getByRole("button", { name: "Publish", exact: true });
  await until("Publish waits for a change", () => publishButton.isDisabled(), Boolean);
  await drawer.getByLabel("What the image shows").fill("Morning bake on the counter, fresh");
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  await until("an edit after the publish turns Publish on again", () => publishButton.isEnabled(), Boolean);
  check("the editor says the edit is not published",
    (await page.getByText("Published revision 1 · changes not published.", { exact: true }).count()) === 1);
  await capture(page, "03-changed-after-publish");
  const tv = await page.context().newPage();
  await tv.setViewportSize({ width: 1280, height: 720 });
  const tvReads = [];
  await tv.route("**/v1/screens/media/**", (route) => {
    tvReads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg("#c58b4e") });
  });
  await tv.goto(`${PORTAL}/tv`);
  const codeText = tv.locator(".tv-code");
  await codeText.waitFor({ timeout: 15_000 });
  const code = (await codeText.textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await page.getByRole("button", { name: "Add a screen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a screen" });
  await dialog.getByLabel("Code from the screen").fill(code.toLowerCase());
  await dialog.getByLabel("Name", { exact: true }).fill("Window TV");
  await dialog.getByRole("button", { name: "Pair screen", exact: true }).click();
  await page.getByText("Window TV", { exact: true }).waitFor({ timeout: 15_000 });
  const tvImage = tv.locator(".menu-board img.menu-board-image");
  await tvImage.waitFor({ timeout: 30_000 });
  check("the TV image loads", await until("the TV image loads", () => imageLoaded(tvImage), Boolean));
  check("the TV reads the screen media route of this shop",
    tvReads.length > 0 && tvReads[0] === `/v1/screens/media/${encodeURIComponent(fixtures.organisationId)}/${BAKE.mediaId}`, tvReads);
  check("the TV image keeps its fit and alt text",
    (await tvImage.getAttribute("data-fit")) === "contain" && (await tvImage.getAttribute("alt")) === "Morning bake on the counter");
  await capture(tv, "04-tv-image");
  await otherContext.close();
  return { result: "passed", checks, captures, uploads };
}
