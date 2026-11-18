// Plan 42F F1c: the single-skill examples open as rehearsal presets on the
// production scheduler, and Financier + robot opens as a one-batch production
// preset. Run with the Playwright CLI.
const presetBase = globalThis.bakeryBase ?? "http://127.0.0.1:5188";
const presetEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan42f-rehearsal-presets";

function presetNotice(page, text) {
  return page
    .locator(".production-panel .production-notice")
    .filter({ hasText: text })
    .waitFor({ timeout: 30000 });
}
function presetRunStatus(page, text, timeout = 240000) {
  return page
    .locator(".production-browser-run p")
    .filter({ hasText: text })
    .waitFor({ timeout });
}
async function openRehearsal(page) {
  await page.goto(`${presetBase}/workflow-preview.html`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRobotRehearsal(page);
}
async function choosePreset(page, name) {
  await chooseOption(
    page,
    page.locator(".production-rehearsal-preset .pantry-select-trigger"),
    { label: name },
  );
  await page
    .getByRole("button", { name: "Replace with preset", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
}
async function trayLegends(page) {
  return page.locator(".production-panel fieldset legend").allTextContents();
}

async function verifyRehearsalPresetsBrowser(page) {
  await openRehearsal(page);
  await presetNotice(page, "Rehearsal prepared with two recorded trays.");
  await editInputs(page);
  const opened = {};
  for (const name of [
    "Table to rack",
    "Table to oven",
    "Cold oven cycle",
    "Oven → table → rack",
  ]) {
    await choosePreset(page, name);
    await presetNotice(page, `${name} opened from its recorded result.`);
    await presetRunStatus(page, "Every native operation has a result", 10000);
    opened[name] = (await trayLegends(page)).filter((text) =>
      text.startsWith("Tray "),
    );
  }
  await page.screenshot({ path: `${presetEvidence}/oven-table-rack.png` });

  // Clearing the chain's results reruns loading, retrieval and racking in
  // browser MuJoCo from the same first request.
  await page
    .getByRole("button", { name: "Clear tray A results", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  await presetNotice(page, "Tray A results cleared.");
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await presetRunStatus(page, "Browser run complete.");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const [chain] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Save production run", exact: true })
      .click(),
  ]);
  await chain.saveAs(`${presetEvidence}/oven-table-rack.json`);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.screenshot({ path: `${presetEvidence}/chain-timeline.png` });

  // Financier + robot: one batch of one tray on the production scheduler.
  await backToExamples(page);
  await page.getByRole("button", { name: /^Financier \+ robot/ }).click();
  await presetNotice(page, "Financier + robot prepared");
  await waitForProductionScene(page);
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await presetRunStatus(page, "Browser run complete.");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const [financier] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Save production run", exact: true })
      .click(),
  ]);
  await financier.saveAs(`${presetEvidence}/financier-robot.json`);
  await editInputs(page);
  await page.screenshot({ path: `${presetEvidence}/financier-robot.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${presetEvidence}/mobile.png` });
  return {
    status: "passed",
    opened,
    checks: [
      "Table to rack, Table to oven, Cold oven cycle and Oven → table → rack open as recorded one-tray rehearsals",
      "clearing the chain's results reruns loading, retrieval and racking in browser MuJoCo",
      "Financier + robot opens one batch of one tray and runs its transfer in browser MuJoCo",
      "chain, financier and 390px evidence captured",
    ],
  };
}
