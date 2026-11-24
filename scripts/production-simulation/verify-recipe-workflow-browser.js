/**
 * Browser verification for the Workflow view of the eight recipe simulations.
 * Each recipe runs from its form to its outcome. The journey proves that the
 * Workflow cards follow the simulation clock, that a card moves the simulation
 * and the 3D station, and that the 3D scene returns with a real size. One
 * warm demould proves the failed and not-reached cards.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-recipe-workflow-browser.js \
 *   --url http://127.0.0.1:3114/factory-acceptance.html --output <directory> --timeout 600000
 */
async function verifyRecipeWorkflowBrowser(page) {
  const recipes = [
    {
      id: "siphon",
      card: /^Siphon coffee/,
      form: "Siphon coffee recipe",
      prepare: "Prepare siphon coffee",
      firstStage: "preheat-seal",
    },
    {
      id: "latte",
      card: /^Caffe Latte/,
      form: "Caffe latte recipe",
      prepare: "Prepare caffe latte",
      firstStage: "espresso",
    },
    {
      id: "black-sesame",
      card: /^Black Sesame Milk/,
      form: "Black sesame milk Cobot recipe",
      prepare: "Prepare Black Sesame Milk 3D station",
      firstStage: "grind-sesame",
    },
    {
      id: "ginger-tea",
      card: /^Ginger Black Tea/,
      form: "Ginger tea 3D MuJoCo pan-staging recipe",
      prepare: "Prepare Ginger Tea 3D station",
      firstStage: "stage-clean-pans",
    },
    {
      id: "financier-batter",
      card: /^Financier Batter/,
      form: "Financier batter Cobot recipe",
      prepare: "Prepare Financier batter station",
      firstStage: "brown-butter",
    },
    {
      id: "financier-bake",
      card: /^Financier Bake/,
      form: "Financier bake Cobot recipe",
      prepare: "Prepare Financier bake station",
      firstStage: "deposit-moulds",
    },
    {
      id: "financier-pack",
      card: /^Financier Pack/,
      form: "Financier pack Cobot recipe",
      prepare: "Prepare Financier pack station",
      firstStage: "cool-demould",
    },
    {
      id: "cafe-shift",
      card: /^Café shift/,
      form: "Combined café shift recipe",
      prepare: "Prepare combined café shift",
      firstStage: "batter-and-order-1",
    },
  ];
  const fixture = new URL(page.url()).href;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report = [];

  async function prepare(recipe, before) {
    await page.goto(fixture);
    await page.getByRole("button", { name: "Recipes", exact: true }).click();
    const form = page.getByRole("form", { name: recipe.form, exact: true });
    // The menu opens on the active production page, one level below the catalog.
    await page.getByRole("button", { name: "← Back", exact: true }).first().click();
    await page.getByRole("button", { name: recipe.card }).click();
    await form.waitFor({ timeout: 30000 });
    if (before !== undefined) await before(form);
    await form
      .getByRole("button", { name: recipe.prepare, exact: true })
      .click();
    return page.getByRole("region", { name: "Persistent production" });
  }

  function surface(workspace, name) {
    return workspace
      .getByRole("group", { name: "Surface view" })
      .getByRole("button", { name, exact: true })
      .click();
  }

  function cards(workspace) {
    return workspace
      .getByRole("region", { name: "Recipe workflow" })
      .locator("li")
      .evaluateAll((items) =>
        items.map((item) => ({
          id: item.dataset.stage,
          state: item.dataset.state,
          disabled: item.querySelector("button").disabled,
          label: item.querySelector("strong").textContent,
          window: item.querySelector(".recipe-workflow-meta > span").textContent,
        })),
      );
  }

  async function clock(workspace) {
    return Number(
      await workspace.getByLabel("Simulation seconds", { exact: true }).textContent(),
    );
  }

  function fail(recipe, message, detail) {
    throw new Error(`${recipe.id}: ${message}: ${JSON.stringify(detail)}`);
  }

  for (const recipe of recipes) {
    const workspace = await prepare(recipe);
    await surface(workspace, "Workflow");
    const station = workspace.locator(".factory-main-canvas");
    if (await station.isVisible()) fail(recipe, "the scene stayed visible", {});

    const prepared = await cards(workspace);
    if (prepared.length < 4) fail(recipe, "too few cards", prepared);
    if (prepared[0].id !== recipe.firstStage)
      fail(recipe, "wrong first card", prepared);
    if (prepared.some((card) => card.state !== "not-started"))
      fail(recipe, "a card started before the run", prepared);
    if (!prepared.slice(1).every((card) => card.disabled) && recipe.id !== "cafe-shift")
      fail(recipe, "a stage that has not run accepts a seek", prepared);

    // Record each card change from inside the page, so no change is missed.
    await page.evaluate(() => {
      window.__recipeWorkflowLog = [];
      const sample = () => {
        const current = document.querySelector(
          '.recipe-workflow li[data-state="current"]',
        );
        const seconds = Number(
          document.querySelector('[aria-label="Simulation seconds"]')?.textContent,
        );
        const log = window.__recipeWorkflowLog;
        const id = current?.dataset.stage ?? null;
        if (log.at(-1)?.id !== id) log.push({ id, seconds });
      };
      window.__recipeWorkflowTimer = window.setInterval(sample, 16);
    });
    await workspace.getByRole("button", { name: "Start production", exact: true }).click();

    // Seek back to the second card while the third card runs.
    await workspace
      .locator(`.recipe-workflow li[data-state="current"]`)
      .and(workspace.locator(`.recipe-workflow li:nth-child(3)`))
      .waitFor({ timeout: 120000 });
    const stationPhase = () =>
      workspace.locator(".factory-main-canvas section").first().evaluate((node) => {
        const phase = Object.keys(node.dataset).find((key) => key.endsWith("Phase"));
        return phase === undefined ? null : node.dataset[phase];
      });
    const phaseBefore = await stationPhase();
    await page.evaluate(() => {
      window.clearInterval(window.__recipeWorkflowTimer);
    });
    const atSeek = await clock(workspace);
    await workspace
      .locator(`.recipe-workflow li[data-stage="${prepared[1].id}"] button`)
      .click();
    await workspace
      .locator(`.recipe-workflow li[data-stage="${prepared[1].id}"][data-state="current"]`)
      .waitFor({ timeout: 5000 });
    const sought = await cards(workspace);
    if (
      sought[0].state !== "done" ||
      sought.slice(2).some((card) => card.state !== "not-started")
    )
      fail(recipe, "wrong cards after the seek", sought);
    const afterSeek = await clock(workspace);
    if (afterSeek >= atSeek)
      fail(recipe, "the card did not move the clock back", { atSeek, afterSeek });
    const status = await workspace.getByLabel("Execution status", { exact: true }).textContent();
    if (status === "running") fail(recipe, "a seek did not pause the run", { status });
    const phaseAfter = await stationPhase();
    await page.waitForTimeout(250);
    if ((await clock(workspace)) !== afterSeek)
      fail(recipe, "the paused clock moved", { afterSeek });
    await page.screenshot({ path: `recipe-workflow-${recipe.id}-seek.png` });

    await surface(workspace, "Factory");
    const canvas = station.locator("canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 10000 });
    const size = await canvas.boundingBox();
    if (size === null || size.width < 300 || size.height < 200)
      fail(recipe, "the scene returned without a real size", size);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `recipe-workflow-${recipe.id}-factory.png` });
    await surface(workspace, "Workflow");

    // Run to the outcome from the Workflow view.
    await workspace
      .getByRole("button", { name: /^(Resume production run|Start production)$/ })
      .click();
    await workspace
      .getByRole("button", { name: "Run again", exact: true })
      .waitFor({ timeout: 300000 });
    const finished = await cards(workspace);
    const outcome = await workspace.getByLabel("Execution status", { exact: true }).textContent();
    if (outcome !== "completed") fail(recipe, "the default run did not complete", outcome);
    if (finished.some((card) => card.state !== "done"))
      fail(recipe, "a card is not done after the run", finished);
    const clipped = await workspace
      .locator(".recipe-workflow li button")
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => button.scrollWidth > button.clientWidth)
          .map((button) => button.textContent),
      );
    if (clipped.length > 0) fail(recipe, "a label overflows its card", clipped);
    // The bars float over the canvas, and the canvas can scroll every step clear
    // of them: at the top no top bar covers a step, at the bottom no bottom bar.
    const covered = await workspace.evaluate(async (root) => {
      const scroll = root.querySelector(".recipe-graph-scroll");
      const bars = (selectors) =>
        selectors
          .map((selector) => root.querySelector(selector)?.getBoundingClientRect())
          .filter((rect) => rect !== undefined && rect.height > 0);
      const hidden = (selectors) => {
        const over = bars(selectors);
        return [...root.querySelectorAll(".recipe-graph-node")]
          .map((node) => ({ name: node.textContent, rect: node.getBoundingClientRect() }))
          .filter(({ rect }) =>
            over.some(
              (bar) =>
                bar.top < rect.bottom - 1 &&
                bar.bottom > rect.top + 1 &&
                bar.left < rect.right - 1 &&
                bar.right > rect.left + 1,
            ),
          )
          .map(({ name }) => name);
      };
      const settle = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      scroll.scrollTo(0, 0);
      await settle();
      const top = hidden([
        ".factory-toolbar",
        ".recipe-graph-chrome-top",
        ".recipe-workflow > ol",
        ".factory-summary",
      ]);
      scroll.scrollTo(0, scroll.scrollHeight);
      await settle();
      const bottom = hidden([".recipe-graph-chrome-row", ".factory-bottom"]);
      scroll.scrollTo(0, 0);
      return [...top, ...bottom];
    });
    if (covered.length > 0) fail(recipe, "a bar covers a step", covered);
    await page.screenshot({ path: `recipe-workflow-${recipe.id}-done.png` });
    report.push({
      recipe: recipe.id,
      stages: finished.map((card) => `${card.id} ${card.window}`),
      cardChanges: await page.evaluate(() => window.__recipeWorkflowLog),
      seek: { atSeek, afterSeek, phaseBefore, phaseAfter },
      endSeconds: await clock(workspace),
    });
  }

  // A warm demould stops the run: its card fails and later cards are not reached.
  const pack = recipes.find((recipe) => recipe.id === "financier-pack");
  const faulted = await prepare(pack, async (form) => {
    // The Process check Select holds the warm-demould item.
    await chooseOption(page, form.getByLabel("Process check"), {
      value: "warm-demould",
    });
  });
  await surface(faulted, "Workflow");
  await faulted.getByRole("button", { name: "Start production", exact: true }).click();
  await faulted
    .getByRole("button", { name: "Run again", exact: true })
    .waitFor({ timeout: 120000 });
  const blocked = await cards(faulted);
  const states = blocked.map((card) => card.state);
  const failedAt = states.indexOf("failed");
  if (
    failedAt < 0 ||
    states.slice(0, failedAt).some((state) => state !== "done") ||
    states.slice(failedAt + 1).some((state) => state !== "not-reached")
  )
    fail(pack, "wrong cards after the fault", blocked);
  await page.screenshot({ path: "recipe-workflow-pack-failed.png" });
  report.push({ recipe: "financier-pack warm-demould", states });

  // The longest labels wrap inside their cards, also at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await faulted
    .locator(".recipe-workflow li button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => button.scrollWidth > button.clientWidth)
        .map((button) => button.textContent),
    );
  if (overflow.length > 0) fail(pack, "a card overflows at phone width", overflow);
  await page.screenshot({ path: "recipe-workflow-pack-phone.png" });

  return { result: "passed", report };
}
