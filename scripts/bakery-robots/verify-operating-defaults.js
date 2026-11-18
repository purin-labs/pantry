async function verifyOperatingDefaults(page) {
  page.setDefaultTimeout(8000);
  // Real shift data lives in the Scenarios dock, behind the "More" menu.
  const openRealShiftData = async () => {
    await openScenarios(page);
    await page
      .getByRole("heading", { name: "Real shift data", exact: true })
      .waitFor();
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole("button", { name: "Play shift", exact: true }).waitFor();
  const sidebar = page.getByRole("button", {
    name: "Collapse sidebar",
    exact: true,
  });
  if (await sidebar.isVisible()) await sidebar.click();
  const inputs = page.getByRole("button", { name: "Inputs", exact: true });
  if ((await inputs.getAttribute("aria-expanded")) !== "true")
    await inputs.click();
  await page
    .getByRole("button", { name: "Normal morning", exact: true })
    .click();
  const initialFinish = await page.getByText(/^Finish ~/).innerText();
  if (
    (await page
      .getByRole("spinbutton", { name: "Workers", exact: true })
      .inputValue()) !== "2"
  )
    throw new Error("Morning shift must start with two workers");
  await page.getByText("More settings", { exact: true }).click();
  const cooling = page.getByRole("spinbutton", {
    name: "Cooling after demoulding (minutes)",
    exact: true,
  });
  if ((await cooling.inputValue()) !== "20")
    throw new Error("Missing post-demould cooling default");
  await cooling.fill("30");
  if ((await page.getByText(/^Finish ~/).innerText()) !== initialFinish)
    throw new Error("Editing a draft changed the applied schedule");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  const longerCoolingFinish = await page.getByText(/^Finish ~/).innerText();
  if (longerCoolingFinish === initialFinish)
    throw new Error("Cooling edit did not delay packing");
  await openRealShiftData();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", {
        name: "Download blank measurement template",
        exact: true,
      })
      .click(),
  ]);
  await download.saveAs(
    "output/playwright/plan42-operating-defaults/downloaded-template.json",
  );
  const importer = page.getByLabel("Import measured shift JSON", {
    exact: true,
  });
  await importer.setInputFiles(
    "apps/portal/src/features/workflow-simulator/fixtures/measured-shift-synthetic.json",
  );
  await page
    .getByRole("rowheader", { name: "Cool before packing", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Put suggested values in draft", exact: true })
    .click();
  await inputs.click();
  if ((await cooling.inputValue()) !== "20")
    throw new Error("Measured cooling did not enter the draft");
  if ((await page.getByText(/^Finish ~/).innerText()) !== longerCoolingFinish)
    throw new Error("Import bypassed Apply");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  const importedFinish = await page.getByText(/^Finish ~/).innerText();
  await page.screenshot({
    path: "output/playwright/plan42-operating-defaults/intake.png",
  });
  await openRealShiftData();
  for (const filename of [
    "old-observations.json",
    "overlapping-cooling.json",
  ]) {
    await importer.setInputFiles(
      `output/playwright/plan42-operating-defaults/${filename}`,
    );
    await page.getByRole("alert").waitFor();
    if ((await page.getByText(/^Finish ~/).innerText()) !== importedFinish)
      throw new Error("Rejected observations replaced the applied schedule");
  }
  await inputs.click();
  await page.getByRole("button", { name: "One worker", exact: true }).click();
  if (
    (await page
      .getByRole("spinbutton", { name: "Workers", exact: true })
      .inputValue()) !== "1"
  )
    throw new Error("One-worker comparison is missing");
  const oneWorkerFinish = await page.getByText(/^Finish ~/).innerText();
  await page
    .getByRole("button", { name: "Normal morning", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close Edit inputs", exact: true })
    .click();
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.getByRole("button", { name: /Cool before packing/ }).waitFor();
  await page.screenshot({
    path: "output/playwright/plan42-operating-defaults/workflow.png",
  });
  return {
    initialFinish,
    longerCoolingFinish,
    importedFinish,
    oneWorkerFinish,
    syntheticObservations: true,
    draftIsolation: true,
    coolingPhaseVisible: true,
    invalidObservationsPreserveRun: true,
    template:
      "output/playwright/plan42-operating-defaults/downloaded-template.json",
  };
}
