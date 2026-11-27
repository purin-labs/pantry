// Plan 24 spanner-oven (Maruzen MBCO-4ME) browser parity journey.
// Runs the 3-leg combined spanner cycle in browser MuJoCo, then compares
// UR5e (with live load-chart estimate) and FANUC CRX-10iA/L in the spanner cell.
const spannerEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan24-spanner-oven";

async function verifySpannerOvenBrowser(page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openRecordingViewer(page);

  await page
    .getByRole("button", { name: /Spanner oven → table → rack \(MBCO-4ME\)/ })
    .click();
  await page
    .locator(".physics-loaded")
    .filter({ hasText: /FR10/ })
    .waitFor({ timeout: 240000 });
  const focus = page.getByRole("button", {
    name: "Focus robot cell",
    exact: true,
  });
  await focus.waitFor({ state: "visible" });
  await focus.click();
  await page.screenshot({ path: `${spannerEvidence}/spanner-rack-cycle.png` });

  await page.getByRole("tab", { name: "Compare & files", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Robot selection and comparison",
  });
  await chooseOption(
    page,
    panel.getByRole("combobox", { name: "Workcell", exact: true }),
    { value: "spanner-oven" },
  );
  const robotSelect = panel.getByRole("combobox", {
    name: "Robot",
    exact: true,
  });
  const arms = await selectItems(page, robotSelect);
  if (arms.length !== 3)
    throw new Error(`Expected 3 spanner arms, found ${arms.length}`);

  await chooseOption(page, robotSelect, { value: "universal-robots-ur5e" });
  await panel
    .getByRole("button", { name: "Run selected robot", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 180000 });
  const ur5eRow = panel.locator("tbody tr").first();
  if (!(await ur5eRow.innerText()).includes("completed"))
    throw new Error("UR5e spanner-oven load did not complete");
  await ur5eRow
    .getByText(/^Below estimated chart limit · margin \d+\.\d\d kg$/)
    .waitFor();
  await ur5eRow.getByRole("button", { name: "View recording" }).click();
  await focus.waitFor({ state: "visible" });
  await focus.click();
  await page.screenshot({ path: `${spannerEvidence}/spanner-ur5e.png` });

  const toggleSetup = page.getByRole("button", {
    name: "Setup & files",
    exact: true,
  });
  if ((await toggleSetup.getAttribute("aria-expanded")) !== "true")
    await toggleSetup.click();
  await chooseOption(page, robotSelect, { value: "fanuc-crx10ial" });
  await panel
    .getByRole("button", { name: "Run selected robot", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 180000 });
  const crxRow = panel.locator("tbody tr").first();
  if (!(await crxRow.innerText()).includes("completed"))
    throw new Error("FANUC CRX-10iA/L spanner-oven load did not complete");

  const pendingExport = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Export comparison", exact: true })
    .click();
  const downloaded = await pendingExport;
  await downloaded.saveAs(`${spannerEvidence}/spanner-crx10-comparison.json`);
  await panel.screenshot({ path: `${spannerEvidence}/spanner-comparison.png` });

  return {
    status: "passed",
    arms: arms.length,
    checks: [
      "FR10 spanner oven → table → rack 3-leg cycle runs and renders in browser MuJoCo",
      "Spanner workcell selector offers FR10, UR5e and FANUC CRX-10iA/L",
      "UR5e spanner-oven load completes with live below-chart load assessment and playback",
      "FANUC CRX-10iA/L spanner-oven load completes and exports comparison JSON",
    ],
  };
}
