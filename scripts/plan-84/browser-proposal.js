async (page) => {
  // Plan 84 Journey J7 on the page: a person reviews an agent's proposal, runs the
  // comparison and approves it. The other person's page has only the shared draft.
  // /test/propose runs the tool's own preparation, so no model turn is needed here.
  // `tests/e2e/bakery-workflow-agent.test.ts` covers the turn itself.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-84/browser-proposal.js \
  //   --entry /workflow-draft-preview.html --artifacts output/acceptance/plan-84/j7-browser
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const fixtures = JOURNEY_FIXTURES;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const entry = `${PORTAL}/workflow-draft-preview.html?organisation=${fixtures.organisationId}&chat=/chat-page`;
  // The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
    if ("values" in choice) {
      const wanted = choice.values.map(String);
      for (const item of await items.all()) {
        const chosen = wanted.includes(await item.getAttribute("data-value"));
        const selected = (await item.getAttribute("aria-selected")) === "true";
        if (chosen !== selected) await item.click();
      }
      await page.keyboard.press("Escape");
    } else if ("value" in choice) {
      await popup
        .locator(
          `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
        )
        .click();
    } else if ("label" in choice) {
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }

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
  const panel = (target) =>
    target.getByRole("region", { name: "Agent proposal", exact: true });
  const list = (target) =>
    target.getByRole("region", { name: "Agent proposals", exact: true });
  const FIELDS = {
    step: null,
    label: null,
    stepKind: null,
    seconds: null,
    workers: null,
    from: null,
    to: null,
    outcome: null,
  };
  const warm = (key, label) => [
    {
      ...FIELDS,
      kind: "add_step",
      workflow: "latte-order",
      step: key,
      label,
      stepKind: "wait",
      seconds: 20,
    },
    {
      ...FIELDS,
      kind: "connect",
      workflow: "latte-order",
      from: "transfer-cup",
      to: key,
    },
    {
      ...FIELDS,
      kind: "connect",
      workflow: "latte-order",
      from: key,
      to: "pour-latte",
    },
  ];
  async function propose(target, changes, reason) {
    const reply = await target.request.post(`${WORKER}/test/propose`, {
      data: { organisationId: fixtures.organisationId, changes, reason },
    });
    if (!reply.ok()) throw new Error(`Propose: ${await reply.text()}`);
  }

  await signIn(page, "Owner");
  await openDraft(page);
  const browser = page.context().browser();
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, "Other");
  await openDraft(other);

  // 1. The proposal reaches the owner's open page with no reload, and only theirs.
  await propose(page, warm("warm-cup", "Warm the cup"), "The cup is cold.");
  await list(page).waitFor({ timeout: 15_000 });
  check(
    "the list shows the agent's reason",
    (await list(page).textContent()).includes("The cup is cold."),
  );
  await other.waitForTimeout(1_500);
  check("the other person sees no proposal", (await list(other).count()) === 0);
  check(
    "their draft has no such step",
    (await step(other, "warm-cup").count()) === 0,
  );

  // 2. Review draws it over the applied revision. The badge comes from the diff, and
  //    no number appears before a comparison.
  await list(page).getByRole("button", { name: "Review" }).click();
  await panel(page).waitFor();
  await step(page, "warm-cup").waitFor();
  check(
    "the new step has its badge",
    (await step(page, "warm-cup").getAttribute("data-change")) === "Added",
  );
  check(
    "an unchanged step has no badge",
    (await step(page, "pour-latte").getAttribute("data-change")) === null,
  );
  const before = await panel(page)
    .locator('[data-proposal="simulated"]')
    .textContent();
  check(
    "no number before a comparison",
    before.includes("Not simulated yet") && !/\d/u.test(before),
    before,
  );
  const changes = await panel(page)
    .locator('[data-proposal="changes"]')
    .textContent();
  check(
    "the change list comes from the diff",
    changes.includes("Warm the cup"),
  );
  check(
    "the proposal cannot be edited",
    await tool(page, "Add step").isDisabled(),
  );
  await page.screenshot({ path: `${ARTIFACTS}/01-review.png` });

  // 3. The numbers are the comparison's own.
  await tool(page, "Run proposal").click();
  const table = page.getByRole("region", { name: "Draft comparison" });
  await table.waitFor({ timeout: 240_000 });
  const appliedEnd = parseFloat(
    await table.locator('[data-result="applied-end"]').textContent(),
  );
  const draftEnd = parseFloat(
    await table.locator('[data-result="draft-end"]').textContent(),
  );
  check("the wait adds its 20 seconds", draftEnd - appliedEnd === 20, {
    appliedEnd,
    draftEnd,
  });
  const after = await panel(page)
    .locator('[data-proposal="simulated"]')
    .textContent();
  check(
    "the summary shows the same numbers",
    after.includes(appliedEnd.toFixed(1)) &&
      after.includes(draftEnd.toFixed(1)),
    after,
  );
  await page.screenshot({ path: `${ARTIFACTS}/02-compared.png` });

  // 4. Approve writes the revision. Both pages read it, and the draft has the step.
  await panel(page).getByRole("button", { name: "Approve" }).click();
  await page
    .getByRole("status", { name: "Proposal result" })
    .filter({ hasText: "Applied revision 2" })
    .waitFor({ timeout: 30_000 });
  await other
    .getByRole("status", { name: "Draft status" })
    .filter({ hasText: "Revision 2." })
    .waitFor({ timeout: 30_000 });
  await step(other, "warm-cup").waitFor({ timeout: 15_000 });
  await step(page, "warm-cup").waitFor();
  check(
    "the draft has nothing left to apply",
    (await step(page, "warm-cup").getAttribute("data-change")) === null,
  );
  check(
    "the badge stays until the next revision",
    (await step(page, "warm-cup").getAttribute("data-approved")) === "Added",
  );
  check("nothing is left to apply", await tool(page, "Apply").isDisabled());
  check("no proposal waits", (await list(page).count()) === 0);
  await page.screenshot({ path: `${ARTIFACTS}/03-approved.png` });

  // 4b. A re-run starts from the new revision, with the proposal's end time.
  await tool(page, "Run draft").click();
  await table.waitFor({ timeout: 240_000 });
  await page
    .locator('[data-result="applied-end"]')
    .filter({ hasText: draftEnd.toFixed(1) })
    .waitFor({ timeout: 240_000 });
  check("the applied run now ends at the proposal's time", true, draftEnd);

  // 4c. A reload keeps the badge, and Fit shows the whole graph.
  await page.reload();
  await openDraft(page);
  check(
    "the badge survives a reload",
    (await step(page, "warm-cup").getAttribute("data-approved")) === "Added",
  );
  await tool(page, "Fit").click();
  const fitted = await page.evaluate(() => {
    const scroll = document.querySelector(".recipe-graph-scroll");
    return scroll.scrollWidth <= scroll.clientWidth;
  });
  check("Fit shows the whole width", fitted);
  await tool(page, "Fit").click();

  // 4d. A phone shows the steps as a list, and a step opens the same drawer.
  await page.setViewportSize({ width: 375, height: 800 });
  const phone = await page.evaluate(() => ({
    position: getComputedStyle(
      document.querySelector(".recipe-graph-node-frame"),
    ).position,
    needs: getComputedStyle(document.querySelector(".recipe-graph-needs"))
      .display,
    wide: document.documentElement.scrollWidth > window.innerWidth,
  }));
  check(
    "a phone shows a list",
    phone.position === "static" && phone.needs === "block",
    phone,
  );
  await step(page, "warm-cup").click();
  await page.getByRole("complementary", { name: "Step details" }).waitFor();
  await page.screenshot({ path: `${ARTIFACTS}/03b-phone.png` });
  await page.getByRole("button", { name: "Close step details" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 4e. The drawer sets the earliest start, and the draft carries it to the other page.
  await step(page, "warm-cup").click();
  const fields = page.getByRole("complementary", { name: "Step details" });
  const earliest = fields.getByLabel("Earliest start, seconds", {
    exact: true,
  });
  await earliest.fill("3");
  await earliest.blur();
  await page.getByRole("button", { name: "Close step details" }).click();
  await page
    .locator('[data-draft-status="synced"]')
    .waitFor({ timeout: 15_000 });
  await step(other, "warm-cup")
    .locator("xpath=.")
    .filter({ hasText: "Changed" })
    .waitFor({ timeout: 15_000 });
  check("the other page marks the changed step", true);
  await step(page, "warm-cup").click();
  await fields.getByLabel("Earliest start, seconds", { exact: true }).fill("0");
  await fields.getByLabel("Earliest start, seconds", { exact: true }).blur();
  await page.getByRole("button", { name: "Close step details" }).click();
  await page
    .locator('[data-draft-status="synced"]')
    .waitFor({ timeout: 15_000 });

  // 5. Decline changes nothing.
  await propose(
    page,
    warm("rest-milk", "Rest the milk"),
    "The milk needs rest.",
  );
  await list(page).waitFor({ timeout: 15_000 });
  await list(page).getByRole("button", { name: "Review" }).click();
  await panel(page).getByRole("button", { name: "Decline" }).click();
  await page
    .getByRole("status", { name: "Proposal result" })
    .filter({ hasText: "You declined" })
    .waitFor({ timeout: 15_000 });
  check(
    "the declined step is gone",
    (await step(page, "rest-milk").count()) === 0,
  );

  // 6. The other person changes the same step during a review. Their work wins.
  await propose(
    page,
    [
      {
        ...FIELDS,
        kind: "set_step",
        workflow: "latte-order",
        step: "warm-cup",
        seconds: 40,
      },
    ],
    "The cup needs longer.",
  );
  await list(page).waitFor({ timeout: 15_000 });
  await list(page).getByRole("button", { name: "Review" }).click();
  await panel(page).waitFor();
  await step(other, "warm-cup").click();
  const drawer = other.getByRole("complementary", { name: "Step details" });
  const name = drawer.getByLabel("Name", { exact: true });
  await name.fill("Warm the cup twice");
  await name.blur();
  await other
    .locator('[data-draft-status="synced"]')
    .waitFor({ timeout: 15_000 });
  await panel(page).getByRole("button", { name: "Approve" }).click();
  await page
    .getByRole("status", { name: "Proposal result" })
    .filter({ hasText: "A person changed the same steps" })
    .waitFor({ timeout: 15_000 });
  check(
    "the revision did not move",
    (
      await page.getByRole("status", { name: "Draft status" }).textContent()
    ).includes("Revision 2."),
  );
  await step(page, "warm-cup")
    .filter({ hasText: "Warm the cup twice" })
    .waitFor({ timeout: 15_000 });
  await page.screenshot({ path: `${ARTIFACTS}/04-person-wins.png` });

  // 7. A decision that rejects is a finding. Ask the agent puts words in the chat box,
  //    and the person sends them.
  await other
    .getByRole("complementary", { name: "Step details" })
    .getByRole("button", { name: "Close step details" })
    .click();
  await tool(other, "Undo").click();
  await other
    .locator('[data-draft-status="synced"]')
    .waitFor({ timeout: 15_000 });
  await propose(
    page,
    [
      {
        ...FIELDS,
        kind: "add_decision",
        workflow: "latte-order",
        step: "cup-check",
        label: "Is the cup warm?",
      },
      {
        ...FIELDS,
        kind: "connect",
        workflow: "latte-order",
        from: "warm-cup",
        to: "cup-check",
      },
    ],
    "A person checks the cup.",
  );
  await list(page).waitFor({ timeout: 15_000 });
  await list(page).getByRole("button", { name: "Review" }).click();
  await panel(page).getByRole("button", { name: "Approve" }).click();
  await page
    .getByRole("status", { name: "Proposal result" })
    .filter({ hasText: "Applied revision 3" })
    .waitFor({ timeout: 30_000 });
  await chooseOption(
    page,
    page.getByRole("toolbar", { name: "Draft tools" }).getByLabel("Reviews"),
    { value: "reject" },
  );
  await tool(page, "Run draft").click();
  const ask = page.getByRole("button", { name: "Ask the agent" });
  await ask.waitFor({ timeout: 240_000 });
  await page.route("**/chat-page", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Chat</p>" }),
  );
  await ask.click();
  await page.waitForURL("**/chat-page");
  const words = await page.evaluate(() =>
    sessionStorage.getItem("connector-chat-draft:/chat-page"),
  );
  check(
    "the chat box holds the finding",
    words !== null && words.includes("cup-check"),
    words,
  );

  // A person's own words from the canvas reach the chat box as a draft. No turn starts.
  await other.route("**/chat-page", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Chat</p>" }),
  );
  await other
    .getByRole("textbox", { name: "Tell the agent what to change" })
    .fill("Shorten the longest wait");
  await other.keyboard.press("Enter");
  // The draft's own address names the chat page too, so match the path.
  await other.waitForURL((url) => url.pathname === "/chat-page");
  const asked = await other.evaluate(() =>
    sessionStorage.getItem("connector-chat-draft:/chat-page"),
  );
  check(
    "the chat box holds the person's words and the workflow",
    asked !== null &&
      asked.includes("Shorten the longest wait") &&
      asked.includes("recipe workflow latte-"),
    asked,
  );

  await otherContext.close();
  return { result: "passed", checks };
};
