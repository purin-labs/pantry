// Run through browser-acceptance.mjs. Uses the current page origin and shared Rust worker.
const selectionEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/ingredient-agent-comparison";

async function saveSelectionDownload(page, button, name) {
  const pending = page.waitForEvent("download");
  await button.click();
  const download = await pending;
  await download.saveAs(`${selectionEvidence}/${name}.json`);
}

async function showSelectionSetup(page) {
  const button = page.getByRole("button", {
    name: "Setup & files",
    exact: true,
  });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
}

async function verifyRobotSelectionBrowser(page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openRecordingViewer(page);
  await page.getByRole("tab", { name: "Compare & files", exact: true }).click();
  const comparison = page.getByRole("region", {
    name: "Robot selection and comparison",
  });
  await comparison
    .getByRole("combobox", { name: "Robot", exact: true })
    .waitFor();
  const armCount = (
    await selectItems(
      page,
      comparison.getByRole("combobox", { name: "Robot", exact: true }),
    )
  ).length;
  await chooseOption(
    page,
    comparison.getByRole("combobox", { name: "Robot", exact: true }),
    { value: "fairino-fr10" },
  );
  await chooseOption(
    page,
    comparison.getByRole("combobox", { name: "Task", exact: true }),
    { value: "table-to-oven" },
  );
  await comparison
    .getByRole("button", { name: "Run selected robot", exact: true })
    .click();
  await comparison
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 125000 });
  if (!(await comparison.locator("tbody tr").innerText()).includes("completed"))
    throw new Error("FR10 oven loading did not complete");
  await saveSelectionDownload(
    page,
    comparison.getByRole("button", { name: "Export comparison" }),
    "fr10-oven",
  );
  await chooseOption(
    page,
    comparison.getByRole("combobox", { name: "Task", exact: true }),
    { value: "table-to-oven" },
  );
  await chooseOption(
    page,
    comparison.getByRole("combobox", { name: "Robot", exact: true }),
    { value: "universal-robots-ur5e" },
  );
  await comparison
    .getByRole("button", { name: "Run selected robot", exact: true })
    .click();
  await comparison
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 125000 });
  const selected = comparison.locator("tbody tr");
  if (!(await selected.innerText()).includes("completed"))
    throw new Error("Universal Robots UR5e oven loading did not complete");
  await saveSelectionDownload(
    page,
    comparison.getByRole("button", { name: "Export comparison" }),
    "selected-ur5e",
  );
  await selected.getByRole("button", { name: "View recording" }).click();
  await page
    .getByRole("button", { name: "Focus robot cell", exact: true })
    .waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Focus robot cell", exact: true })
    .click();
  await page.screenshot({ path: `${selectionEvidence}/ur5e-playback.png` });
  await showSelectionSetup(page);
  await comparison
    .getByRole("button", { name: "Compare existing arms", exact: true })
    .click();
  await comparison
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 240000 });
  const rows = comparison.locator("tbody tr");
  if ((await rows.count()) !== armCount * 2)
    throw new Error("Comparison must contain every arm and two repeats");
  if (
    (await comparison
      .getByRole("cell", { name: "Matches baseline", exact: true })
      .count()) !== armCount
  )
    throw new Error("Motion repeats differ");
  await saveSelectionDownload(
    page,
    comparison.getByRole("button", { name: "Export comparison" }),
    "comparison",
  );
  await comparison.screenshot({ path: `${selectionEvidence}/comparison.png` });
  await comparison
    .getByLabel("Ingredient mass (kg)", { exact: true })
    .fill("0.75");
  await comparison
    .getByLabel("Forward offset (mm)", { exact: true })
    .fill("-100");
  await comparison
    .getByLabel("Lateral offset (mm)", { exact: true })
    .fill("60");
  await comparison
    .getByRole("button", { name: "Compare existing arms", exact: true })
    .click();
  await comparison
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 240000 });
  if ((await rows.count()) !== armCount * 2)
    throw new Error("Load comparison omitted an arm");
  await saveSelectionDownload(
    page,
    comparison.getByRole("button", { name: "Export comparison" }),
    "ingredient-comparison",
  );
  await comparison.screenshot({
    path: `${selectionEvidence}/ingredient-comparison.png`,
  });
  const assessed = rows.filter({ hasText: "Universal Robots UR5e" }).first();
  await assessed
    .getByText(/^Below estimated chart limit · margin -?\d+\.\d\d kg$/)
    .screenshot({
      path: `${selectionEvidence}/ur5e-load-assessment.png`,
    });
  for (const load of [
    { massKg: "1.1", label: "Near estimated chart limit", file: "near-chart" },
    {
      massKg: "1.25",
      label: "Above estimated chart limit",
      file: "above-chart",
    },
  ]) {
    await comparison
      .getByLabel("Ingredient mass (kg)", { exact: true })
      .fill(load.massKg);
    await comparison
      .getByLabel("Forward offset (mm)", { exact: true })
      .fill("0");
    await comparison
      .getByLabel("Lateral offset (mm)", { exact: true })
      .fill("0");
    await comparison
      .getByRole("button", { name: "Run selected robot", exact: true })
      .click();
    await comparison
      .getByRole("status")
      .filter({ hasText: "Run complete." })
      .waitFor({ timeout: 125000 });
    await comparison
      .getByText(new RegExp(`^${load.label} · margin `))
      .first()
      .waitFor();
    await saveSelectionDownload(
      page,
      comparison.getByRole("button", { name: "Export comparison" }),
      load.file,
    );
  }
  // Restore the default load for the existing saved-run and native parity journey.
  await comparison
    .getByLabel("Ingredient mass (kg)", { exact: true })
    .fill("1");
  await comparison.getByLabel("Forward offset (mm)", { exact: true }).fill("0");
  await comparison.getByLabel("Lateral offset (mm)", { exact: true }).fill("0");
  await comparison
    .getByRole("button", { name: "Run selected robot", exact: true })
    .click();
  await comparison
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 125000 });
  const ur5e = rows.filter({ hasText: "Universal Robots UR5e" }).first();
  await ur5e.getByRole("button", { name: "View recording" }).click();
  await showSelectionSetup(page);
  await page
    .getByRole("button", { name: "Rehearse this recording", exact: true })
    .click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await saveSelectionDownload(
    page,
    page.getByRole("button", { name: "Save production run", exact: true }),
    "saved-run",
  );
  await page
    .getByLabel("Open production run or native recording", { exact: true })
    .setInputFiles(`${selectionEvidence}/saved-run.json`);
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "File checked." })
    .waitFor({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Review saved run", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await saveSelectionDownload(
    page,
    page.getByRole("button", { name: "Export native request", exact: true }),
    "restored-request",
  );
  await page.screenshot({
    path: `${selectionEvidence}/saved-run-restored.png`,
  });
  await editInputs(page);
  const assignments = page.getByLabel("Workcell robot assignments", {
    exact: true,
  });
  await assignments.waitFor({ state: "visible" });
  if (!(await assignments.innerText()).includes("Universal Robots UR5e"))
    throw new Error(
      "Restored cell assignment did not show Universal Robots UR5e",
    );
  await page.screenshot({ path: `${selectionEvidence}/cell-assignments.png` });
  return {
    status: "passed",
    checks: [
      "FR10 oven loading completes with collision detection in the shared Wasm worker",
      "restored rehearsal shows its saved robot cell assignment",
      "selected Universal Robots UR5e runs in the shared Wasm worker and opens Three.js playback",
      "all existing arms run twice with identical motion per arm",
      "comparison export contains the complete recordings",
      "selected-arm recording enters the production scheduler and exports a validated saved run",
      "saved production run reopens through the existing file boundary",
    ],
  };
}
