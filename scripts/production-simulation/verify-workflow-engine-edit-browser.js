/**
 * Plan 84 Journey J2, recipes in the engine workspace: a recipe with no fixed
 * animation is also editable. Pour-over runs its draft on a real cell, and the
 * bakery shift opens one workflow at a time because it has many steps.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-workflow-engine-edit-browser.js \
 *   --url http://127.0.0.1:3184/factory-acceptance.html --output <directory> --timeout 600000
 */
async function verifyWorkflowEngineEditBrowser(page) {
  const fixture = new URL(page.url()).href;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report = {};
  function fail(message, detail) {
    throw new Error(`${message}: ${JSON.stringify(detail)}`);
  }
  const graph = page.getByRole("group", { name: "Recipe prerequisites" });
  const nodes = () => graph.locator(".recipe-graph-node");
  const step = (key) =>
    page.locator(`.recipe-graph-node[data-graph-node="${key}"]`);
  const tool = (name) =>
    page
      .getByRole("toolbar", { name: "Draft tools" })
      .getByRole("button", { name, exact: true });
  const drawer = () =>
    page.getByRole("complementary", { name: "Step details" });
  async function workflowSurface() {
    await page
      .locator('[aria-label="Surface view"]')
      .getByText("Workflow", { exact: true })
      .click();
    await page
      .locator('.recipe-graph[data-graph="ready"]')
      .waitFor({ timeout: 120000 });
  }

  // Pour-over: edit, run on the real cell, and compare.
  await page.goto(fixture);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByRole("button", { name: "← Back", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /^Pour-over/u }).click();
  await page
    .getByRole("form", { name: "Pour-over recipe", exact: true })
    .getByRole("button", { name: "Prepare pour-over", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .waitFor({ timeout: 120000 });
  await workflowSurface();
  const keys = await nodes().evaluateAll((items) =>
    items.map((item) => item.dataset.graphNode),
  );
  if (keys.length === 0) fail("no steps", keys);
  await step(keys[0]).click();
  await drawer().waitFor();
  await tool("Add wait").click();
  await step("new-wait").waitFor();
  const seconds = drawer().getByLabel("Seconds", { exact: true });
  await seconds.fill("25");
  await seconds.blur();
  await drawer().getByRole("button", { name: "Close step details" }).click();
  if ((await step("new-wait").getAttribute("data-change")) !== "Added")
    fail("no Added badge", "new-wait");
  // The first step's next step now waits for the new one, so the end moves.
  const next = keys[1];
  if (next !== undefined) {
    await step(next).click();
    await drawer().getByRole("checkbox", { name: "New wait" }).check();
    await drawer().getByRole("button", { name: "Close step details" }).click();
  }
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "Run draft",
    );
    return button !== undefined && !button.disabled;
  });
  await tool("Run draft").click();
  await page
    .getByRole("region", { name: "Draft comparison" })
    .waitFor({ timeout: 300000 });
  const read = async (name) =>
    page.locator(`[data-result="${name}"]`).textContent();
  report.pourOver = {
    steps: keys.length,
    applied: await read("applied-end"),
    draft: await read("draft-end"),
    draftStatus: await read("draft-status"),
    appliedTasks: await read("applied-tasks"),
    draftTasks: await read("draft-tasks"),
  };
  if (report.pourOver.draftStatus !== "completed")
    fail("the draft did not complete", report.pourOver);
  if (
    Number(report.pourOver.draftTasks) <= Number(report.pourOver.appliedTasks)
  )
    fail("the draft ran no more steps", report.pourOver);
  await page.screenshot({ path: "workflow-engine-pour-over.png" });

  // The shift: many steps, so it opens on one workflow, and any can show.
  await page.goto(fixture);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByRole("button", { name: "← Back", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /^Café shift/u }).click();
  await page
    .getByRole("form", { name: "Bakery shift", exact: true })
    .getByRole("button", { name: "Prepare bakery shift", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .waitFor({ timeout: 120000 });
  await workflowSurface();
  const filter = page.locator(
    '.recipe-graph-filter:not(.recipe-graph-run) .pantry-select-trigger',
  );
  const options = (await selectItems(page, filter)).map((item) => item.value);
  if (options.length < 3) fail("too few workflows", options);
  // A large recipe opens with one node for each workflow, and a click opens one.
  const overview = page.locator("[data-graph-workflow]");
  const opening = await overview.count();
  if (opening !== options.length - 2)
    fail("the overview needs one node for each workflow", { opening, options });
  await overview.nth(1).click();
  const clicked = await nodes().count();
  if (clicked === 0 || (await overview.count()) !== 0)
    fail("a click did not open the workflow", { clicked });
  await chooseOption(page, filter, { value: "" });
  const all = await nodes().count();
  if (all <= clicked) fail("All shows no more steps", { clicked, all });
  await chooseOption(page, filter, { value: options[2] });
  const one = await nodes().count();
  if (one === 0 || one >= all) fail("the filter did not narrow", { one, all });
  await page.screenshot({ path: "workflow-engine-shift.png" });
  report.shift = { workflows: opening, clicked, all, one };
  return { result: "passed", report };
}
