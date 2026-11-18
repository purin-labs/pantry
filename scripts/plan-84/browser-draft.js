async (page) => {
  // Plan 84 Journey J3 in real browsers: two signed-in people on one recipe's
  // shared draft, against a local Worker with its own D1, R2 and the built account
  // Worker. The room, the revision store and the Worker's admission make each
  // outcome here. The Worker journey `tests/e2e/bakery-workflow-draft.test.ts` also
  // covers lost access and a refused apply.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-84/browser-draft.js \
  //   --entry /workflow-draft-preview.html --artifacts output/acceptance/plan-84/j3-browser
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const fixtures = JOURNEY_FIXTURES;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const entry = `${PORTAL}/workflow-draft-preview.html?organisation=${fixtures.organisationId}`;

  async function signIn(target, user) {
    const session = await target.request.post(
      `${WORKER}/test/session?user=${user}`,
    );
    if (!session.ok()) throw new Error(`Session failed for ${user}`);
  }
  async function openDraft(target) {
    await target.setViewportSize({ width: 1440, height: 1000 });
    await target.goto(entry);
    await target
      .getByRole("group", { name: "Surface view" })
      .getByRole("button", { name: "Workflow", exact: true })
      .click();
    await target
      .locator('.recipe-graph[data-graph="ready"]')
      .waitFor({ timeout: 60_000 });
    await target
      .locator('[data-draft-status="synced"]')
      .waitFor({ timeout: 30_000 });
  }
  const step = (target, key) =>
    target.locator(`.recipe-graph-node[data-graph-node="${key}"]`);
  const tool = (target, name) =>
    target
      .getByRole("toolbar", { name: "Draft tools" })
      .getByRole("button", { name, exact: true });
  const drawer = (target) =>
    target.getByRole("complementary", { name: "Step details" });
  async function setField(target, name, value) {
    const field = drawer(target).getByLabel(name, { exact: true });
    await field.fill(String(value));
    await field.blur();
  }
  async function closeDrawer(target) {
    await drawer(target)
      .getByRole("button", { name: "Close step details" })
      .click();
  }
  const status = (target) =>
    target.getByRole("status", { name: "Draft status" }).textContent();

  // 1. The owner opens the recipe, and the compiled recipe becomes revision 1.
  await signIn(page, "Owner");
  await openDraft(page);
  check(
    "the first open applies revision 1",
    (await status(page)).includes("Revision 1."),
    await status(page),
  );
  check("Apply waits for a change", await tool(page, "Apply").isDisabled());

  // 2. A second person opens the same draft in another browser.
  const browser = page.context().browser();
  const otherContext = await browser.newContext();
  // Offline mode does not cut an open WebSocket. This route can drop one for real.
  const sockets = [];
  let blocked = false;
  await otherContext.routeWebSocket(/\/bakery\/workflows\//u, (socket) => {
    if (blocked) {
      socket.close();
      return;
    }
    sockets.push(socket);
    socket.connectToServer();
  });
  const other = await otherContext.newPage();
  await signIn(other, "Other");
  await openDraft(other);
  check(
    "both people see the same revision",
    (await status(other)).includes("Revision 1."),
    await status(other),
  );
  await other
    .getByRole("status", { name: "Draft status" })
    .filter({ hasText: "2 people on this draft" })
    .waitFor({ timeout: 15_000 });

  // 3. An edit reaches the other page, with no reload.
  await step(page, "transfer-cup").click();
  await tool(page, "Add step").click();
  await step(page, "new-step").waitFor();
  await setField(page, "Name", "Warm the cup");
  await setField(page, "Seconds", 5);
  await closeDrawer(page);
  await step(other, "new-step").waitFor({ timeout: 15_000 });
  await other
    .locator('[data-graph-node="new-step"]')
    .filter({ hasText: "Warm the cup" })
    .waitFor({ timeout: 15_000 });
  check(
    "the other page marks the step as added",
    (await step(other, "new-step").getAttribute("data-change")) === "Added",
  );
  await page.screenshot({ path: `${ARTIFACTS}/01-owner-added.png` });
  await other.screenshot({ path: `${ARTIFACTS}/02-other-sees-it.png` });

  // 4. An edit made without a connection arrives after the reconnect.
  blocked = true;
  for (const socket of sockets) await socket.close();
  await other
    .locator('[data-draft-status="reconnecting"]')
    .waitFor({ timeout: 60_000 });
  await step(other, "pour-latte").click();
  await drawer(other).getByRole("checkbox", { name: "Warm the cup" }).check();
  await closeDrawer(other);
  blocked = false;
  await other
    .locator('[data-draft-status="synced"]')
    .waitFor({ timeout: 60_000 });
  await page
    .locator('g[data-prerequisite$="/new-step"][data-dependent$="/pour-latte"]')
    .waitFor({ timeout: 15_000 });
  check("the offline edit reached the owner", true);

  // 5. A reload reads the same draft from the room.
  await page.reload();
  await openDraft(page);
  check(
    "the draft survives a reload",
    (await step(page, "new-step").textContent()).includes("Warm the cup"),
  );
  check(
    "the arrow survives a reload",
    (await page
      .locator(
        'g[data-prerequisite$="/new-step"][data-dependent$="/pour-latte"]',
      )
      .count()) === 1,
  );

  // 6. The owner applies it. The Worker admits it, and both pages read revision 2.
  await tool(page, "Apply").click();
  const appliedStatus = page
    .getByRole("status", { name: "Draft status" })
    .filter({ hasText: "Applied revision 2" });
  await appliedStatus.waitFor({ timeout: 30_000 }).catch(async () => {
    const alerts = await page.getByRole("alert").allTextContents();
    throw new Error(
      `No applied status: ${await status(page)} ${alerts.join(" | ")}`,
    );
  });
  await other
    .getByRole("status", { name: "Draft status" })
    .filter({ hasText: "Revision 2." })
    .waitFor({ timeout: 30_000 });
  check(
    "an applied step is no longer a change",
    (await step(page, "new-step").getAttribute("data-change")) === null,
  );
  await page.screenshot({ path: `${ARTIFACTS}/03-applied.png` });
  const revision = await page.request.get(
    `${PORTAL}/v1/control/organisations/${fixtures.organisationId}/bakery/workflows`,
  );
  check(
    "the list path is not a route",
    revision.status() === 404,
    revision.status(),
  );

  // 7. A reload starts from the applied revision, with no change to apply.
  await page.reload();
  await openDraft(page);
  check(
    "the reload reads revision 2",
    (await status(page)).includes("Revision 2."),
    await status(page),
  );
  check("nothing is left to apply", await tool(page, "Apply").isDisabled());
  await otherContext.close();
  return { result: "passed", checks };
};
