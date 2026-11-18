// Hario ECA-3-B Electric Coffee Syphon browser journey:
// prepare recipe, start, inspect upflow/fold-in/steep/drawdown across camera
// presets, pause and resume, complete vacuum drawdown, test Run again, and
// verify fault handling on an unsealed neck gasket.
async function verifySiphonBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", previewStyles);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);

  await openSiphonRecipeForm(page);
  const author = page.getByRole("form", {
    name: "Siphon coffee recipe",
    exact: true,
  });
  await author.getByLabel("Lower bulb water (g)").fill("350");
  await author.getByLabel("Coffee dose (g)").fill("24");
  await author.getByLabel("Steep time (s)").fill("45");
  await author.screenshot({ path: "siphon-author.png" });
  await author
    .getByRole("button", { name: "Prepare siphon coffee", exact: true })
    .click();

  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();

  const station = page.getByRole("region", {
    name: "Accepted siphon coffee station state",
    exact: true,
  });
  await page
    .locator("[data-siphon-stage]")
    .filter({ hasText: /Carrying siphon flask|Placing siphon flask/ })
    .first()
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: "siphon-flask-place.png" });

  await page
    .locator("[data-siphon-stage]")
    .filter({ hasText: /Pressing upper bowl down|Releasing flask on burner/ })
    .first()
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: "siphon-seal-press.png" });

  await station
    .getByRole("button", { name: "Chambers close-up", exact: true })
    .click();
  await page
    .locator('[data-siphon-phase="upflow"]')
    .first()
    .waitFor({ timeout: 60000 });
  await page
    .locator("[data-siphon-brew-seconds]")
    .filter({ hasText: /^0:1[6-9]|^0:2[0-5]/ })
    .first()
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: "siphon-upflow-closeup.png" });

  await station
    .getByRole("button", { name: "Bench view", exact: true })
    .click();
  await page
    .locator("[data-siphon-stage]")
    .filter({
      hasText:
        /Approaching BA-15 stirring rod|Grasping BA-15 stirring rod|Lifting BA-15 stirring rod|Rotating stirring rod/,
    })
    .first()
    .waitFor({ timeout: 60000 });
  await page.screenshot({ path: "siphon-paddle-table-pick.png" });

  await page
    .locator("[data-siphon-stage]")
    .filter({ hasText: "Fold-in circular stir" })
    .waitFor({ timeout: 60000 });
  await page.screenshot({ path: "siphon-fold-in-bench.png" });

  await station
    .getByRole("button", { name: "Overhead stir", exact: true })
    .click();
  await page
    .locator("[data-siphon-stage]")
    .filter({ hasText: "Fold-in circular stir 2" })
    .or(
      page
        .locator("[data-siphon-stage]")
        .filter({ hasText: "Fold-in circular stir 3" }),
    )
    .first()
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: "siphon-fold-in-overhead.png" });

  await station
    .getByRole("button", { name: "Bench view", exact: true })
    .click();
  await page
    .locator('[data-siphon-phase="steep"]')
    .first()
    .waitFor({ timeout: 60000 });

  await page
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "paused" })
    .waitFor();
  const paused = await readSiphonValues(page);
  await page.screenshot({ path: "siphon-steep-paused.png" });

  await page
    .getByRole("button", { name: "Resume production run", exact: true })
    .click();

  await page
    .locator('[data-siphon-phase="drawdown"]')
    .first()
    .waitFor({ timeout: 90000 });
  await station
    .getByRole("button", { name: "Chambers close-up", exact: true })
    .click();
  await page
    .locator("[data-siphon-beverage]")
    .filter({ hasText: /^1[3-9]\d|^2[0-4]\d/ })
    .first()
    .waitFor({ timeout: 30000 });
  await page.screenshot({ path: "siphon-drawdown.png" });

  await station
    .getByRole("button", { name: "Bench view", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 90000 });
  const completed = await readSiphonValues(page);
  await page.screenshot({ path: "siphon-completed.png" });

  // Verify Run again button resets and restarts the simulation.
  const runAgain = page.getByRole("button", {
    name: "Run again",
    exact: true,
  });
  await runAgain.waitFor();
  await runAgain.click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "running" })
    .waitFor({ timeout: 30000 });

  // Return to recipes and verify the unsealed-gasket fault mode.
  await page
    .getByRole("button", { name: "Back to recipes", exact: true })
    .click();
  await openSiphonRecipeForm(page);
  await chooseOption(page, author.getByLabel("Process check"), {
    value: "unsealed-gasket",
  });
  await author
    .getByRole("button", { name: "Prepare siphon coffee", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page
    .locator('[data-siphon-failure="unsealed-gasket-leak"]')
    .waitFor({ timeout: 60000 });
  const failed = await readSiphonValues(page);
  await page.screenshot({ path: "siphon-gasket-failure.png" });

  return {
    result: "passed",
    paused,
    completed,
    failed,
  };
}

async function readSiphonValues(page) {
  const station = page.locator(".siphon-station").first();
  await station.waitFor();
  const read = async (selector, attribute) =>
    station.locator(selector).first().getAttribute(attribute);
  return {
    phase: await station.getAttribute("data-siphon-phase"),
    step: Number(await station.getAttribute("data-siphon-step")),
    stage: await station.locator("[data-siphon-stage]").textContent(),
    pressureKPa: await read(
      "[data-siphon-pressure]",
      "data-siphon-pressure",
    ),
    beverageG: await read(
      "[data-siphon-beverage]",
      "data-siphon-beverage",
    ),
    tdsPct: await read("[data-siphon-tds]", "data-siphon-tds"),
  };
}

async function openSiphonRecipeForm(page) {
  const form = page.getByRole("form", {
    name: "Siphon coffee recipe",
    exact: true,
  });
  if (await form.isVisible()) return;
  const recipesButton = page.getByRole("button", {
    name: "Recipes",
    exact: true,
  });
  const switchWorkflow = page.getByRole("button", {
    name: /Switch workflow/i,
  });
  await recipesButton
    .or(switchWorkflow)
    .or(form)
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  if (await form.isVisible()) return;
  if (await recipesButton.isVisible()) {
    await recipesButton.click();
  }
  if (!(await form.isVisible())) {
    await switchWorkflow.waitFor({ state: "visible", timeout: 15000 });
    await switchWorkflow.click();
    const siphonButton = page
      .getByRole("button", { name: /Siphon coffee physics/i })
      .first();
    await siphonButton.waitFor({ state: "visible", timeout: 15000 });
    await siphonButton.click();
  }
  await form.waitFor({ state: "visible", timeout: 15000 });
}

async function openWorkspace(page) {
  await page.reload();
  await page.evaluate(mountWorkflowSimulator, { kind: "standalone" });
}

verifySiphonBrowser;
