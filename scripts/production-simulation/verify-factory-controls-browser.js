async function verifyFactoryControlsBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", factoryControlStyles);
  await page.reload();
  await page.addScriptTag({ content: factoryNodeText.toString() });
  await page.evaluate(mountFactoryControls);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The Combined Café Shift section holds the two-cell route.
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
  await page.waitForFunction(factoryHasTwoOrders, null, { timeout: 120000 });
  await page
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page.waitForFunction(factoryControlPaused);
  const paused = await page.evaluate(factoryControlState);
  if (paused.orders < 2 || paused.orders >= 24)
    throw new Error(
      "The journey must close arrivals before all 24 orders arrive.",
    );
  await openFactoryHistory(page);
  await page.getByLabel("Observation seconds", { exact: true }).fill("50");
  await page
    .getByRole("button", { name: "Inspect factory history", exact: true })
    .click();
  await page
    .getByLabel("Observation time", { exact: true })
    .waitFor({ timeout: 120000 });
  // factory-canvas-browser proves cell selection in both panes.
  const factory = page.getByRole("region", {
    name: "Shared recorded factory",
    exact: true,
  });
  await factory.locator("canvas").waitFor();
  if ((await factory.locator("canvas").count()) !== 1)
    throw new Error("The factory must use one renderer for both cells.");
  await page.screenshot({
    path: "shared-recorded-factory.png",
    fullPage: true,
  });
  const historical = await page.evaluate(factoryControlState);
  // In history the clock shows the observed moment; the return to the live
  // state below proves that the paused execution did not change.
  if (historical.observed !== "50.000" || historical.orders !== 1)
    throw new Error(
      `History changed execution or included future orders: ${JSON.stringify(historical)}`,
    );
  if (
    !(await page
      .getByRole("button", { name: "Resume production run", exact: true })
      .isDisabled())
  )
    throw new Error(
      "Historical inspection must not expose live execution controls.",
    );
  await page
    .getByRole("region", { name: "Factory observation cursor", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "historical-factory.png", fullPage: true });
  await page
    .getByRole("button", { name: "Play history at 60×", exact: true })
    .click();
  await page.waitForFunction(factoryHistoryAdvanced);
  const pauseHistory = page.getByRole("button", {
    name: "Pause history",
    exact: true,
  });
  if (await pauseHistory.isEnabled()) await pauseHistory.click();
  const played = await page.evaluate(factoryControlState);
  if (Number(played.observed) > Number(paused.time))
    throw new Error(
      "Playback advanced execution or crossed its accepted boundary.",
    );
  // The shared factory shows the cells at the observed time, never later.
  const shownTime = Number(await factory.getAttribute("data-time"));
  if (!(shownTime <= Number(played.observed) * 1e6))
    throw new Error(
      `History displayed a future sample: ${shownTime} µs after ${played.observed} s.`,
    );
  await page
    .getByRole("button", { name: "Return to live state", exact: true })
    .click();
  const live = await page.evaluate(factoryControlState);
  if (JSON.stringify(live) !== JSON.stringify(paused))
    throw new Error("Inspection mutated the live factory.");
  // The horizon, resource and arrival forms are in the Scenario panel.
  await openFactoryPanel(page, "Scenario");
  await page.getByLabel("New horizon (seconds)", { exact: true }).fill("18000");
  await page
    .getByRole("button", { name: "Review horizon extension", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm scenario change", exact: true })
    .click();
  // The timeline's scale states the horizon; it renders while it is open.
  await showFactoryTimeline(page);
  await page.waitForFunction(factoryHorizonExtended);
  await page.locator(".factory-playback .production-timeline-toggle").click();
  await page
    .getByText("Schedule resource unavailability", { exact: true })
    .click();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Resource to withhold", exact: true }),
    { value: "baker" },
  );
  await page
    .getByLabel("Unavailable from (seconds)", { exact: true })
    .fill("200");
  await page
    .getByLabel("Available again (seconds)", { exact: true })
    .fill("250");
  await page
    .getByRole("button", { name: "Review resource interval", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm scenario change", exact: true })
    .click();
  await page.waitForFunction(factoryControlPaused);
  await page
    .getByRole("button", { name: "Confirm close orders", exact: true })
    .click();
  await page.waitForFunction(factoryClosing);
  await page.addScriptTag({ content: retainFactoryDownload.toString() });
  await page.evaluate(installFactoryDownloadCapture);
  await (
    await downloadFactorySave(page)
  ).saveAs(`${globalThis.bakeryEvidence}/closed-arrivals.json`);
  await backToRecipes(page);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/u)
    .evaluate(restoreFactoryFile);
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await waitForRunState(page, runCompleted);
  const completed = await page.evaluate(factoryControlState);
  if (completed.orders !== paused.orders)
    throw new Error("Restore admitted orders after accepted closure.");
  const rows = await page.locator("[data-order]").allTextContents();
  for (const row of rows)
    if (!row.includes("completed"))
      throw new Error("The closed factory did not drain every order.");
  await openFactoryPanel(page, "Scenario");
  const drain = await page
    .getByRole("region", { name: "Arrival and drain controls", exact: true })
    .textContent();
  if (!drain.includes("Factory drained") || !drain.includes("closed"))
    throw new Error("Arrival closure did not survive restore.");
  const trays = await page.locator('[data-storage="tray-store"]').textContent();
  for (const tray of ["tray-a", "tray-b", "tray-c", "tray-d"])
    if (!trays.includes(tray))
      throw new Error(`Missing returned carrier ${tray}.`);
  await openFactoryPanel(page, "Results");
  await page
    .getByRole("region", { name: "Production results", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "drained-factory.png", fullPage: true });
  return {
    result: "passed",
    paused,
    historical,
    played,
    shownTime,
    completed,
    rows,
    drain,
    trays,
  };
}

async function factoryControlStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}
async function mountFactoryControls() {
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: Route } =
    await import("/src/features/workflow-simulator/route.tsx");
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(Route, { connection: { kind: "preview" } }),
    ),
  );
}
function factoryHasTwoOrders() {
  return (
    Number(
      document.querySelector('[aria-label="Simulation seconds"]')?.textContent,
    ) >= 160
  );
}
function factoryControlPaused() {
  return (
    document
      .querySelector('[aria-label="Persistent production"]')
      ?.getAttribute("data-lifecycle") === "settled" &&
    document.querySelector('[aria-label="Execution status"]')?.textContent ===
      "paused"
  );
}
function factoryClosing() {
  return document
    .querySelector('[data-arrival-source="orders"]')
    ?.textContent.includes("closing");
}
function factoryHistoryAdvanced() {
  return (
    Number(
      document.querySelector('[aria-label="Observation time"]')?.textContent,
    ) > 45
  );
}
function factoryHorizonExtended() {
  return (
    document
      .querySelector('[aria-label="Persistent production"]')
      ?.textContent.includes("18000.000") &&
    document
      .querySelector('[aria-label="Persistent production"]')
      ?.getAttribute("data-lifecycle") === "settled"
  );
}
function factoryControlState() {
  return {
    time: document.querySelector('[aria-label="Simulation seconds"]')
      ?.textContent,
    observed:
      document.querySelector('[aria-label="Observation time"]')?.textContent ??
      null,
    orders: document.querySelectorAll("[data-order]").length,
    stores: Array.from(
      document.querySelectorAll("[data-storage]"),
      factoryNodeText,
    ),
  };
}
function factoryNodeText(node) {
  return node.textContent;
}
function installFactoryDownloadCapture() {
  window.factoryObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = retainFactoryDownload;
}
function retainFactoryDownload(blob) {
  if (blob instanceof Blob && blob.type === "application/json")
    window.factoryArchive = new File([blob], "closed-arrivals.json", {
      type: "application/json",
    });
  return window.factoryObjectURL(blob);
}
function restoreFactoryFile(input) {
  URL.createObjectURL = window.factoryObjectURL;
  if (!(window.factoryArchive instanceof File))
    throw new Error("Missing saved archive.");
  const transfer = new DataTransfer();
  transfer.items.add(window.factoryArchive);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
