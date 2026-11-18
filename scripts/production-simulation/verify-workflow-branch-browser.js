/**
 * Plan 84 Journeys J5 and J6, browser part: a person draws a decision with an arm on
 * the canvas, and the engine runs it. A rejected review runs the arm. An accepted one
 * marks it Skipped. A script decides with no review. A branch cannot hold a tray move.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-workflow-branch-browser.js \
 *   --url http://127.0.0.1:3184/factory-acceptance.html --output <directory> --timeout 600000
 */
async function verifyWorkflowBranchBrowser(page) {
  const fixture = new URL(page.url()).href;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report = {};
  function fail(message, detail) {
    throw new Error(`${message}: ${JSON.stringify(detail)}`);
  }
  const step = (key) =>
    page.locator(`.recipe-graph-node[data-graph-node="${key}"]`);
  const tool = (name) =>
    page
      .getByRole("toolbar", { name: "Draft tools" })
      .getByRole("button", { name, exact: true });
  const drawer = () =>
    page.getByRole("complementary", { name: "Step details" });
  const close = () =>
    drawer().getByRole("button", { name: "Close step details" }).click();
  async function setField(name, value) {
    const field = drawer().getByLabel(name, { exact: true });
    await field.fill(String(value));
    await field.blur();
  }
  async function runDraft(review) {
    await chooseOption(
      page,
      page
        .locator(".recipe-graph-filter")
        .filter({ hasText: "Reviews" })
        .locator('.pantry-select-trigger'),
      { value: review },
    );
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent === "Run draft",
      );
      return button !== undefined && !button.disabled;
    });
    await tool("Run draft").click();
    const comparison = page.getByRole("region", { name: "Draft comparison" });
    await comparison.waitFor({ timeout: 120000 });
    return {
      applied: Number.parseFloat(
        await page.locator('[data-result="applied-end"]').textContent(),
      ),
      draft: Number.parseFloat(
        await page.locator('[data-result="draft-end"]').textContent(),
      ),
      status: await page.locator('[data-result="draft-status"]').textContent(),
    };
  }

  async function openLatte() {
    await page.goto(fixture);
    await page.getByRole("button", { name: "Recipes", exact: true }).click();
    await page
      .getByRole("button", { name: "← Back", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /^Caffe Latte/u }).click();
    const form = page.getByRole("form", {
      name: "Caffe latte recipe",
      exact: true,
    });
    await form.waitFor({ timeout: 30000 });
    await form
      .getByRole("button", { name: "Prepare caffe latte", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Surface view" })
      .getByRole("button", { name: "Workflow", exact: true })
      .click();
    await page
      .locator('.recipe-graph[data-graph="ready"]')
      .waitFor({ timeout: 120000 });
  }
  await openLatte();

  // A decision after the milk, with an arm that steams again and rejoins at the pour.
  await step("steam-whirlpool").click();
  await tool("Add decision").click();
  await step("new-decision").waitFor();
  await setField("Name", "Is the foam right?");
  await tool("Add wait").click();
  await step("new-wait").waitFor();
  await setField("Name", "Steam again");
  await setField("Seconds", 9);
  await chooseOption(
    page,
    drawer().getByRole("combobox", { name: /When Steam again runs after/u }),
    { value: "reject" },
  );
  await close();
  await step("pour-latte").click();
  await drawer().getByRole("checkbox", { name: "Steam again" }).check();
  await close();
  const arrow = page.locator(
    'g[data-prerequisite$="/new-decision"][data-dependent$="/new-wait"][data-branch="reject"]',
  );
  if ((await arrow.count()) !== 1) fail("no reject arrow", await arrow.count());
  if ((await step("new-wait").getAttribute("data-role")) !== "reject")
    fail(
      "the arm step has the wrong role",
      await step("new-wait").getAttribute("data-role"),
    );

  const rejected = await runDraft("reject");
  if (rejected.status !== "completed")
    fail("reject did not complete", rejected);
  if (!(rejected.draft > rejected.applied))
    fail("the arm added no time", rejected);
  if ((await step("new-wait").getAttribute("data-run")) === "skipped")
    fail("a rejected review skipped the arm", rejected);
  await page.screenshot({ path: "workflow-branch-rejected.png" });

  const accepted = await runDraft("accept");
  if (accepted.status !== "completed")
    fail("accept did not complete", accepted);
  if ((await step("new-wait").getAttribute("data-run")) !== "skipped")
    fail("an accepted review did not skip the arm", accepted);
  if (!(await step("new-wait").textContent()).includes("Skipped"))
    fail(
      "the arm shows no Skipped badge",
      await step("new-wait").textContent(),
    );
  if (accepted.draft >= rejected.draft)
    fail("the skipped arm took time", { accepted, rejected });
  await page.screenshot({ path: "workflow-branch-accepted.png" });
  report.person = { rejected, accepted };

  // A script decides with no review, whatever the review setting says.
  await step("new-decision").click();
  await chooseOption(
    page,
    drawer()
      .locator("label", { hasText: "Who decides" })
      .locator('.pantry-select-trigger'),
    { value: "scripted" },
  );
  const script = drawer().getByLabel("Outcome of each arrival", {
    exact: true,
  });
  await script.fill("reject");
  await script.blur();
  await close();
  const scripted = await runDraft("accept");
  if (scripted.status !== "completed")
    fail("the script did not complete", scripted);
  if ((await step("new-wait").getAttribute("data-run")) === "skipped")
    fail("the script did not take the arm", scripted);
  if (Math.abs(scripted.draft - rejected.draft) > 0.01)
    fail("the script's run differs from a rejected review", {
      scripted,
      rejected,
    });
  report.script = scripted;

  // An arrow that leaves the arm and also reaches a step outside it is refused.
  await step("return-pitcher").click();
  await drawer().getByRole("checkbox", { name: "Is the foam right?" }).check();
  await chooseOption(
    page,
    drawer().getByRole("combobox", { name: /When Return pitcher runs after/u }),
    { value: "accept" },
  );
  await close();
  const problems = page.getByRole("alert", { name: "Draft problems" });
  await problems.waitFor({ timeout: 10000 });
  const text = await problems.textContent();
  if (!text.includes("return-pitcher")) fail("the problem names no step", text);
  if (!(await tool("Run draft").isDisabled())) fail("Run stays open", text);
  report.outsideArrow = text;

  // A decision that skips a step of an animated stage: that stage takes no time, and
  // the scene jumps over it.
  await openLatte();
  await step("steam-stretch").click();
  await tool("Add decision").click();
  await step("new-decision").waitFor();
  await setField("Name", "Does it need a whirlpool?");
  await close();
  await step("steam-whirlpool").click();
  await drawer()
    .getByRole("checkbox", { name: "Does it need a whirlpool?" })
    .check();
  await chooseOption(
    page,
    drawer().getByRole("combobox", { name: /When .* runs after/u }),
    { value: "accept" },
  );
  await drawer()
    .getByRole("checkbox", { name: /stretch/iu })
    .uncheck();
  await close();
  await page
    .locator(".recipe-graph-filter")
    .filter({ hasText: "Reviews" })
    .waitFor();
  const jumped = await runDraft("reject");
  if (jumped.status !== "completed") fail("the jump did not complete", jumped);
  if ((await step("steam-whirlpool").getAttribute("data-run")) !== "skipped")
    fail("the whirlpool did not skip", jumped);
  const whirlpool = await page
    .locator(".recipe-workflow")
    .getByText(/Stage \d+ · [\d.]+–[\d.]+ s/u)
    .allTextContents();
  const zero = whirlpool.some((label) => {
    const match = /· ([\d.]+)–([\d.]+) s/u.exec(label);
    return match !== null && match[1] === match[2];
  });
  if (!zero) fail("no stage window closed", whirlpool);
  await page.screenshot({ path: "workflow-branch-jump.png" });
  report.jump = { ...jumped, stages: whirlpool };
  return { result: "passed", report };
}
