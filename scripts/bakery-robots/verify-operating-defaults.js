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
  await openSimulatorInputs(page);
  await page
    .getByRole("button", { name: "Normal morning", exact: true })
    .click();
  const initialFinish = await simulatorFinish(page);
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
  if ((await simulatorFinish(page)) !== initialFinish)
    throw new Error("Editing a draft changed the applied schedule");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  const longerCoolingFinish = await simulatorFinish(page);
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
    `${globalThis.bakeryEvidence}/downloaded-template.json`,
  );
  const importer = page.getByLabel("Import measured shift JSON", {
    exact: true,
  });
  await importer.setInputFiles(
    "areas/kitchen/ui/features/workflow-simulator/fixtures/measured-shift-synthetic.json",
  );
  await page
    .getByRole("rowheader", { name: "Cool before packing", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Put suggested values in draft", exact: true })
    .click();
  await openSimulatorInputs(page);
  if ((await cooling.inputValue()) !== "20")
    throw new Error("Measured cooling did not enter the draft");
  if ((await simulatorFinish(page)) !== longerCoolingFinish)
    throw new Error("Import bypassed Apply");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  const importedFinish = await simulatorFinish(page);
  await page.screenshot({
    path: "output/playwright/plan42-operating-defaults/intake.png",
  });
  await openRealShiftData();
  for (const rejected of await rejectedObservations(page)) {
    await importer.setInputFiles(rejected);
    await page.getByRole("alert").waitFor();
    if ((await simulatorFinish(page)) !== importedFinish)
      throw new Error("Rejected observations replaced the applied schedule");
  }
  await openSimulatorInputs(page);
  await page.getByRole("button", { name: "One worker", exact: true }).click();
  if (
    (await page
      .getByRole("spinbutton", { name: "Workers", exact: true })
      .inputValue()) !== "1"
  )
    throw new Error("One-worker comparison is missing");
  const oneWorkerFinish = await simulatorFinish(page);
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
  // On a phone the simulator fits the screen: no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  if (overflow > 0)
    throw new Error(`The page scrolls sideways at 390 px by ${overflow} px`);
  return {
    result: "passed",
    initialFinish,
    longerCoolingFinish,
    importedFinish,
    oneWorkerFinish,
    syntheticObservations: true,
    draftIsolation: true,
    coolingPhaseVisible: true,
    invalidObservationsPreserveRun: true,
    phoneFitsWithoutSidewaysScroll: true,
    template: `${globalThis.bakeryEvidence}/downloaded-template.json`,
  };
}

// Two observation files that the import refuses, made from the committed
// synthetic shift: an old schema version, and cooling that starts before
// the unload ends.
async function rejectedObservations(page) {
  const fixture = `${new URL(page.url()).origin}${checkoutUrl("areas/kitchen/ui/features/workflow-simulator/fixtures/measured-shift-synthetic.json")}`;
  const shift = await (await page.request.get(fixture)).json();
  const old = { ...shift, schemaVersion: 1 };
  const overlapping = structuredClone(shift);
  const first = overlapping.batches[0].intervals;
  first.cool.start = first.unload.end - 10;
  return [
    ["old-observations.json", old],
    ["overlapping-cooling.json", overlapping],
  ].map(([name, value]) => ({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  }));
}
