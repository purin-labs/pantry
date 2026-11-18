async function verifyPhysicalRecoveryBrowser(page) {
  const evidence = new URL(page.url()).searchParams.get("evidence");
  if (evidence === null)
    throw new Error("Provide the recovery journey evidence URL.");
  const fixture = await page.request.get(
    new URL(`${evidence}/reference-failure-file.json`, page.url()).href,
  );
  if (!fixture.ok()) throw new Error("Run the Wasm recovery journey first.");
  await page.route("**/src/dev/workflow-preview.tsx", recoveryStyles);
  await page.reload();
  await page.evaluate(mountRecoveryWorkspace);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByLabel("Open recipe, oven route or saved production run", {
      exact: true,
    })
    .setInputFiles({
      name: "failed-transfers.json",
      mimeType: "application/json",
      buffer: await fixture.body(),
    });
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  for (const index of [0, 1]) {
    const task = `tray-orders#${index}/transfer`;
    const controls = page.getByRole("region", {
      name: "Physical recovery controls",
      exact: true,
    });
    await controls
      .getByText(`Review recovery for ${task}`, { exact: true })
      .waitFor({ timeout: 120000 });
    const form = page.getByRole("form", {
      name: `Recovery for ${task}`,
      exact: true,
    });
    await chooseOption(
      page,
      form.getByRole("combobox", { name: "Recovery resource", exact: true }),
      { value: "baker" },
    );
    await chooseOption(
      page,
      form.getByRole("combobox", {
        name: "Recovered carrier destination",
        exact: true,
      }),
      { value: "reject-shelf" },
    );
    await form
      .getByLabel("Recovery handling seconds", { exact: true })
      .fill("5");
    await chooseOption(
      page,
      form.getByRole("combobox", {
        name: "Rejected portioned-tray destination",
        exact: true,
      }),
      { value: "rejected-trays" },
    );
    await form
      .getByRole("button", { name: "Review recovery", exact: true })
      .click();
    await controls.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `review-recovery-${index}.png`,
      fullPage: true,
    });
    await controls
      .getByRole("button", { name: "Confirm physical recovery", exact: true })
      .click();
  }
  await page.waitForFunction(recoveryCompleted, null, { timeout: 120000 });
  const orders = await page.locator("[data-order]").allTextContents();
  if (orders.length !== 2 || orders.some(recoveryOrderNotFailed))
    throw new Error("Recovery lost the failed order outcomes.");
  const output = await page
    .getByRole("table", { name: "Reported output", exact: true })
    .textContent();
  if (!output.includes("rejected-output") || !output.includes("2 each"))
    throw new Error("Recovery did not account for both rejected trays.");
  const shelf = await page
    .locator('[data-storage="reject-shelf"]')
    .textContent();
  if (!shelf.includes("tray-a") || !shelf.includes("tray-b"))
    throw new Error("The rejected carriers did not reach storage.");
  await page.getByLabel("Observation seconds", { exact: true }).fill("30");
  await page
    .getByRole("button", { name: "Inspect factory history", exact: true })
    .click();
  await page
    .getByLabel("Observation time", { exact: true })
    .waitFor({ timeout: 120000 });
  const historical = await page.locator("[data-order]").allTextContents();
  for (const row of historical)
    if (!row.includes("open"))
      throw new Error("Later recovery leaked into historical order outcomes.");
  await page
    .getByRole("region", { name: "Production results", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "historical-failed-world.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Return to live state", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  await (
    await download
  ).saveAs(`${globalThis.bakeryEvidence}/recovered-factory.json`);
  return { result: "passed", orders, output, shelf, historical };
}

function recoveryOrderNotFailed(row) {
  return !row.includes("failed");
}
function recoveryCompleted() {
  return (
    document.querySelector('[aria-label="Execution status"]')?.textContent ===
    "completed"
  );
}
async function recoveryStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}
async function mountRecoveryWorkspace() {
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
