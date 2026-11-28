/**
 * Plan 84 Journeys J2 and J4, browser part. The engine and the admission checks
 * produce every outcome here: nothing below fakes a run.
 *
 * J2, black sesame on its real cell: a person adds a step and connects it, and the
 * comparison shows a later finish with the new task on its timeline. The applied run
 * does not change. A removed supplier, a cycle and a removed worker each refuse the
 * run, name the step, and undo clears them.
 *
 * J4, latte: a changed duration stretches its stage, an added step holds the scene,
 * and a removed step shows the original-recipe message. The clock, the stage cards
 * and a seek stay in agreement.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-workflow-edit-browser.js \
 *   --url http://127.0.0.1:3184/factory-acceptance.html --output <directory> --timeout 900000
 */
async function verifyWorkflowEditBrowser(page) {
  const fixture = new URL(page.url()).href;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report = {};

  function fail(message, detail) {
    throw new Error(`${message}: ${JSON.stringify(detail)}`);
  }
  async function open(card, form, prepare) {
    await page.goto(fixture);
    await page.getByRole("button", { name: "Recipes", exact: true }).click();
    const recipe = page.getByRole("form", { name: form, exact: true });
    await page
      .getByRole("button", { name: "← Back", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: card }).click();
    await recipe.waitFor({ timeout: 30000 });
    await recipe.getByRole("button", { name: prepare, exact: true }).click();
    const workspace = page.getByRole("region", {
      name: "Persistent production",
    });
    await surface(workspace, "Workflow");
    await page
      .locator('.recipe-graph[data-graph="ready"]')
      .waitFor({ timeout: 120000 });
    return workspace;
  }
  function surface(workspace, name) {
    return workspace
      .getByRole("group", { name: "Surface view" })
      .getByRole("button", { name, exact: true })
      .click();
  }
  function step(key) {
    return page.locator(`.recipe-graph-node[data-graph-node="${key}"]`);
  }
  function tool(name) {
    return page
      .getByRole("toolbar", { name: "Draft tools" })
      .getByRole("button", { name, exact: true });
  }
  function drawer() {
    return page.getByRole("complementary", { name: "Step details" });
  }
  async function select(key) {
    await step(key).click();
    await drawer().waitFor();
  }
  async function closeDrawer() {
    await drawer().getByRole("button", { name: "Close step details" }).click();
  }
  async function setField(name, value) {
    const field = drawer().getByLabel(name, { exact: true });
    await field.fill(String(value));
    await field.blur();
  }
  async function resultSeconds(name) {
    return Number.parseFloat(
      await page.locator(`[data-result="${name}"]`).textContent(),
    );
  }
  async function runDraft() {
    await tool("Run draft").click();
    await page
      .getByRole("region", { name: "Draft comparison" })
      .waitFor({ timeout: 300000 });
  }
  async function problems() {
    const panel = page.getByRole("alert", { name: "Draft problems" });
    await panel.waitFor({ timeout: 10000 });
    return panel.textContent();
  }
  async function clock(workspace) {
    return Number(
      await workspace
        .getByLabel("Simulation seconds", { exact: true })
        .textContent(),
    );
  }

  // J2: add a step and compare.
  const sesame = await open(
    /^Black sesame milk/,
    "Black sesame milk Cobot recipe",
    "Prepare Black Sesame Milk 3D station",
  );
  const cardsBefore = await sesame
    .getByRole("region", { name: "Recipe workflow" })
    .locator("li[data-stage]")
    .evaluateAll((items) => items.map((item) => item.dataset.state));
  await select("blend");
  await tool("Add step").click();
  await page.waitForSelector('[data-graph-node="new-step"]');
  await setField("Name", "Rest the jar");
  await setField("Seconds", 30);
  const added = step("new-step");
  if ((await added.getAttribute("data-change")) !== "Added")
    fail(
      "the new step has no Added badge",
      await added.getAttribute("data-change"),
    );
  if (!(await added.textContent()).includes("Rest the jar"))
    fail("the name did not reach the step", await added.textContent());
  await closeDrawer();
  // The next step now needs the new one, through the keyboard path of the drawer.
  await select("scrape-and-weigh");
  await drawer().getByRole("checkbox", { name: "Rest the jar" }).check();
  await closeDrawer();
  const arrow = await page
    .locator(
      'g[data-prerequisite$="/new-step"][data-dependent$="/scrape-and-weigh"]',
    )
    .count();
  if (arrow !== 1) fail("the new prerequisite has no arrow", arrow);
  await page.screenshot({ path: "workflow-edit-j2-added.png" });
  await runDraft();
  const appliedEnd = await resultSeconds("applied-end");
  const draftEnd = await resultSeconds("draft-end");
  if (!(draftEnd > appliedEnd))
    fail("the draft does not end later", { appliedEnd, draftEnd });
  const draftStatus = await page
    .locator('[data-result="draft-status"]')
    .textContent();
  if (draftStatus !== "completed")
    fail("the draft did not complete", draftStatus);
  const onTimeline = await page
    .locator('[data-timeline-task$="/new-step"]')
    .count();
  if (onTimeline === 0) fail("the timeline lacks the new task", onTimeline);
  const appliedTasks = Number(
    await page.locator('[data-result="applied-tasks"]').textContent(),
  );
  const draftTasks = Number(
    await page.locator('[data-result="draft-tasks"]').textContent(),
  );
  if (draftTasks <= appliedTasks)
    fail("the draft did not run more steps", { appliedTasks, draftTasks });
  const cardsAfter = await sesame
    .getByRole("region", { name: "Recipe workflow" })
    .locator("li[data-stage]")
    .evaluateAll((items) => items.map((item) => item.dataset.state));
  if (JSON.stringify(cardsAfter) !== JSON.stringify(cardsBefore))
    fail("the shown run changed", { cardsBefore, cardsAfter });
  if ((await clock(sesame)) !== 0) fail("the clock moved", await clock(sesame));
  await page.screenshot({ path: "workflow-edit-j2-compared.png" });
  report.j2 = { appliedEnd, draftEnd, appliedTasks, draftTasks };

  // J2: the refusals. Each one names the step, stops the run, and undo clears it.
  await select("standardize-mass");
  await drawer().getByRole("button", { name: "Remove step" }).click();
  const missing = await problems().catch(() => null);
  const removedText = await page.locator(".recipe-graph-removed").textContent();
  if (!removedText.includes("Standardize mass"))
    fail("the removed list lacks the step", removedText);
  report.j2.removedSupplier = missing;
  if (missing !== null) {
    if (!(await tool("Run draft").isDisabled()))
      fail("Run stays open with a problem", missing);
    if (
      (await page
        .locator('.recipe-graph-node[data-problem="true"]')
        .count()) === 0
    )
      fail("no step is marked", missing);
  }
  await tool("Undo").click();
  await step("standardize-mass").waitFor();

  await select("blend");
  await drawer().getByRole("checkbox", { name: "Standardize mass" }).check();
  const cycle = await problems();
  if (!cycle.includes("wait for each other")) fail("no cycle message", cycle);
  if (!(await tool("Run draft").isDisabled())) fail("Run stays open", cycle);
  report.j2.cycle = cycle;
  await page.screenshot({ path: "workflow-edit-j2-cycle.png" });
  await tool("Undo").click();
  await page
    .getByRole("alert", { name: "Draft problems" })
    .waitFor({ state: "detached", timeout: 10000 });

  await select("blend");
  const worker = drawer()
    .getByRole("group", { name: "Who can do it" })
    .getByRole("checkbox")
    .first();
  const workerChecks = await drawer()
    .getByRole("group", { name: "Who can do it" })
    .getByRole("checkbox")
    .evaluateAll((items) => items.filter((item) => item.checked).length);
  if (workerChecks === 0) fail("the step has no worker", workerChecks);
  for (const box of await drawer()
    .getByRole("group", { name: "Who can do it" })
    .getByRole("checkbox")
    .all())
    if (await box.isChecked()) await box.uncheck();
  const noWorker = await problems();
  if (!noWorker.includes("at least one worker"))
    fail("no worker message", noWorker);
  report.j2.noWorker = noWorker;
  for (let index = 0; index < workerChecks; index++) await tool("Undo").click();
  await page
    .getByRole("alert", { name: "Draft problems" })
    .waitFor({ state: "detached", timeout: 10000 });
  await worker.isVisible();
  await closeDrawer();

  // J2: a drag changes only the place of a step.
  await step("blend").scrollIntoViewIfNeeded();
  const frame = step("blend").locator("xpath=..");
  const before = await frame.boundingBox();
  await page.mouse.move(before.x + 60, before.y + 30);
  await page.mouse.down();
  await page.mouse.move(before.x + 360, before.y + 30, { steps: 6 });
  await page.mouse.up();
  const after = await frame.boundingBox();
  if (Math.abs(after.x - before.x - 300) > 4)
    fail("the drag did not move", after);
  if (await drawer().isVisible()) fail("the drag opened the drawer", after);
  if ((await step("blend").getAttribute("data-change")) !== null)
    fail("a move counts as a change", "blend");

  // J4: a changed duration stretches its stage.
  const latte = await open(
    /^Caffe latte/,
    "Caffe latte recipe",
    "Prepare caffe latte",
  );
  async function cards() {
    return latte
      .getByRole("region", { name: "Recipe workflow" })
      .locator("li[data-stage]")
      .evaluateAll((items) =>
        items.map((item) => ({
          id: item.dataset.stage,
          state: item.dataset.state,
          window: item.querySelector(".recipe-workflow-meta > span")
            .textContent,
        })),
      );
  }
  const original = await cards();
  await select("steam-whirlpool");
  await setField("Seconds", 20);
  await closeDrawer();
  await runDraft();
  const stretched = await cards();
  const whirlpool = stretched.find((card) => card.id === "whirlpool");
  if (!/31–51 s/u.test(whirlpool.window))
    fail("the stage did not stretch", stretched);
  if (!/51–63 s/u.test(stretched.find((card) => card.id === "pour").window))
    fail("the next stage did not move", stretched);
  await latte
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await latte
    .locator(
      '.recipe-workflow li[data-stage="whirlpool"][data-state="current"]',
    )
    .waitFor({ timeout: 60000 });
  const midPhase = await clock(latte);
  if (midPhase < 31 || midPhase >= 51)
    fail("the clock and the stage disagree", midPhase);
  if ((await step("steam-whirlpool").getAttribute("data-state")) !== "current")
    fail("the step does not follow its stage", midPhase);
  await latte
    .getByRole("button", { name: "Run again", exact: true })
    .waitFor({ timeout: 120000 });
  const stretchedEnd = await clock(latte);
  if (stretchedEnd < 65 || stretchedEnd > 67)
    fail("the run does not end at the stretched time", stretchedEnd);
  if (
    (await latte
      .getByLabel("Execution status", { exact: true })
      .textContent()) !== "completed"
  )
    fail("the stretched run did not complete", stretchedEnd);
  // A seek lands in the stage that holds its time.
  await latte.locator('.recipe-workflow li[data-stage="pour"] button').click();
  await latte
    .locator('.recipe-workflow li[data-stage="pour"][data-state="current"]')
    .waitFor({ timeout: 5000 });
  const sought = await clock(latte);
  if (Math.abs(sought - 51) > 0.2) fail("the seek missed the stage", sought);
  report.j4 = { original: original[4].window, stretchedEnd, sought };

  // J4: an added step holds the scene with its label.
  await select("pour-latte");
  await tool("Add wait").click();
  await page.waitForSelector('[data-graph-node="new-wait"]');
  await setField("Name", "Let the foam settle");
  await setField("Seconds", 12);
  await closeDrawer();
  await runDraft();
  await surface(latte, "Factory");
  await latte
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  const hold = page.locator(".recipe-animation-notice");
  await hold.waitFor({ timeout: 90000 });
  const holdText = await hold.textContent();
  if (!holdText.includes("Let the foam settle"))
    fail("no hold label", holdText);
  const holdAt = await clock(latte);
  await page.screenshot({ path: "workflow-edit-j4-hold.png" });
  await latte
    .getByRole("button", { name: "Run again", exact: true })
    .waitFor({ timeout: 120000 });
  const heldEnd = await clock(latte);
  if (heldEnd <= stretchedEnd) fail("the hold added no time", heldEnd);
  report.j4.hold = { holdText, holdAt, heldEnd };

  // J4: a removed stage cannot play correctly, and the view says so.
  await surface(latte, "Workflow");
  await select("return-pitcher");
  await drawer().getByRole("button", { name: "Remove step" }).click();
  await tool("Run draft").waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "Run draft",
    );
    return button !== undefined && !button.disabled;
  });
  await runDraft();
  await surface(latte, "Factory");
  const message = await page.locator(".recipe-animation-notice").textContent();
  if (!message.includes("original recipe")) fail("no message", message);
  await page.screenshot({ path: "workflow-edit-j4-message.png" });
  await surface(latte, "Workflow");
  const originalAgain = await cards();
  if (
    JSON.stringify(originalAgain.map((card) => card.window)) !==
    JSON.stringify(original.map((card) => card.window))
  )
    fail("the cards do not show the original recipe", originalAgain);
  report.j4.message = message;

  return { result: "passed", report };
}
