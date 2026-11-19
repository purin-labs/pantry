/**
 * Start the Portal dev server and open /factory-acceptance.html with Playwright CLI.
 * Pass this file's contents to run-code. Screenshots and a real saved run go to output/playwright.
 */
async function verifyFactoryCanvasBrowser(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(new URL("/factory-acceptance.html", page.url()).href);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await chooseOption(page, page.getByLabel("Logistics comparison"), {
    value: "stress-one-slot",
  });
  await page
    .getByRole("button", { name: "Prepare two-cell route", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  const workspace = page.getByRole("region", {
    name: "Persistent production",
    exact: true,
  });
  const clock = workspace.getByLabel("Simulation seconds", { exact: true });
  await workspace.locator('.factory-pane[data-scene="ready"]').waitFor();
  await clock
    .filter({ hasText: /^(?:9[5-9]\d|[1-9]\d{3,})\./ })
    .waitFor({ timeout: 60000 });
  await workspace
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await workspace
    .locator('[aria-label="Execution status"]')
    .filter({ hasText: "paused" })
    .waitFor();
  const pausedAt = await clock.textContent();
  if (Number(pausedAt) <= 0)
    throw new Error("The native factory did not advance.");
  await workspace.getByRole("tab", { name: "Split", exact: true }).click();
  await workspace
    .locator('.factory-pane[data-camera="floor"][data-scene="ready"]')
    .waitFor();
  if ((await workspace.locator(".factory-pane canvas").count()) !== 2)
    throw new Error("Split view did not mount both canvases.");
  const divider = workspace.getByRole("separator", {
    name: "Resize floor plan",
  });
  await divider.focus();
  await divider.press("ArrowRight");
  if ((await divider.getAttribute("aria-valuenow")) !== "39")
    throw new Error("The split divider did not resize by keyboard.");
  await workspace
    .getByRole("button", { name: "source-cell", exact: true })
    .click();
  const inspector = workspace.getByRole("complementary", {
    name: "Factory details",
  });
  await inspector.waitFor();
  if (
    !(await inspector
      .getByRole("heading", { name: "source-cell", exact: true })
      .isVisible())
  )
    throw new Error("Cell selection did not open its inspector.");
  if (
    (await workspace
      .locator('.factory-station-label[aria-pressed="true"]')
      .count()) !== 2
  )
    throw new Error("The selected cell is not highlighted in both panes.");
  await page.screenshot({ path: "output/playwright/p70-canvas-split.png" });
  await workspace
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Workflow", exact: true })
    .click();
  const task = workspace
    .locator(".factory-workflow-canvas .oven-task-card")
    .first();
  const taskId = await task.getAttribute("data-graph-task");
  await task.click();
  await inspector.waitFor();
  await workspace
    .getByRole("button", { name: "Timeline", exact: true })
    .click();
  await workspace
    .getByRole("region", { name: "Factory timeline", exact: true })
    .waitFor();
  if (taskId === null)
    throw new Error("The selected workflow task has no identity.");
  const selectedTimeline = workspace
    .locator(
      '[data-timeline-task="' + taskId + '"] button[aria-pressed="true"]',
    )
    .first();
  await selectedTimeline.waitFor();
  await page.screenshot({ path: "output/playwright/p70-canvas-workflow.png" });
  if ((await clock.textContent()) !== pausedAt)
    throw new Error("Presentation controls advanced the paused run.");
  await workspace
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Timeline", exact: true })
    .click();
  await workspace.getByRole("button", { name: "Factory", exact: true }).click();
  await workspace.getByRole("tab", { name: "3D view", exact: true }).click();
  await page.screenshot({ path: "output/playwright/p70-canvas-desktop.png" });
  await workspace.getByRole("button", { name: "Save", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await workspace
    .getByRole("button", { name: "Download save file", exact: true })
    .click();
  const download = await downloadEvent;
  const saved = `${globalThis.bakeryEvidence}/p70-canvas-saved-run.json`;
  await download.saveAs(saved);
  await workspace
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await workspace.getByRole("tab", { name: "Split", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace
    .getByRole("tab", { name: "Split", exact: true })
    .waitFor({ state: "hidden" });
  if ((await workspace.locator(".factory-pane canvas").count()) !== 1)
    throw new Error("Small screens retained two cramped canvases.");
  await page.screenshot({ path: "output/playwright/p70-canvas-mobile.png" });
  await workspace.getByRole("tab", { name: "Floor plan", exact: true }).click();
  await workspace
    .locator('.factory-pane[data-camera="floor"][data-scene="ready"]')
    .waitFor();
  await workspace.getByRole("button", { name: "History", exact: true }).click();
  await workspace.getByLabel("Observation seconds", { exact: true }).fill("0");
  await workspace
    .getByRole("button", { name: "Inspect factory history", exact: true })
    .click();
  await workspace
    .getByRole("button", {
      name: "Viewing history · Return to live state",
      exact: true,
    })
    .waitFor();
  if (
    !(await workspace
      .getByRole("button", { name: "Resume production run", exact: true })
      .isDisabled())
  )
    throw new Error("Execution was enabled during history inspection.");
  await workspace
    .getByRole("button", {
      name: "Viewing history · Return to live state",
      exact: true,
    })
    .click();
  if ((await clock.textContent()) !== pausedAt)
    throw new Error("Returning from history changed committed time.");
  await workspace
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await workspace.getByRole("tab", { name: "3D view", exact: true }).click();
  await workspace
    .getByRole("button", { name: "Resume production run", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Pause production run", exact: true })
    .waitFor();
  await workspace
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await workspace
    .locator('[aria-label="Execution status"]')
    .filter({ hasText: "paused" })
    .waitFor();
  const resumedAt = await clock.textContent();
  if (Number(resumedAt) <= Number(pausedAt))
    throw new Error(
      "The run did not resume after changing canvases and inspecting history.",
    );
  await page.reload();
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/u)
    .setInputFiles(saved);
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await workspace
    .locator('[aria-label="Execution status"]')
    .filter({ hasText: "paused" })
    .waitFor();
  const restoredAt = await clock.textContent();
  if (Number(restoredAt) < Number(pausedAt))
    throw new Error("The fresh worker lost saved progress.");
  await workspace.getByRole("tab", { name: "Split", exact: true }).click();
  await workspace
    .locator('.factory-pane[data-camera="floor"][data-scene="ready"]')
    .waitFor();
  await page.screenshot({ path: "output/playwright/p70-canvas-restored.png" });
  return {
    result: "passed",
    restoredAt,
    scenario: "stress-one-slot",
    pausedAt,
    resumedAt,
    taskId,
    splitCanvases: 2,
    mobileCanvases: 1,
    save: saved,
  };
}
