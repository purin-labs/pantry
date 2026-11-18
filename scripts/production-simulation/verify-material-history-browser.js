async function verifyMaterialHistoryBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", materialHistoryStyles);
  await openPhysicsEvidence(page);
  await page.evaluate(mountMaterialHistory);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByText("Individual recipes and logistics examples", { exact: true })
    .click();
  await page.getByLabel("Cooling grids", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Prepare full recipe", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "awaiting-inspection" })
    .waitFor();
  const reserved = await inspectMaterialAt(page, "575", "0", "745000");
  await page
    .locator('[data-material-storage-history="hazelnut-batter-holding"] summary')
    .click();
  await page
    .getByRole("button", {
      name: "hazelnut-preparation-batches#0/store-batter: 745000",
      exact: true,
    })
    .click();
  if (
    !(
      (await page
        .getByRole("button", {
          name: "hazelnut-preparation-batches#0/store-batter: 745000",
          exact: true,
        })
        .getAttribute("aria-pressed")) === "true"
    )
  )
    throw new Error("A material reservation did not select its task.");
  const filled = await inspectMaterialAt(page, "600", "745000", "0");
  await page.screenshot({
    path: "material-before-portioning.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Return to live state", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  const held = `${globalThis.bakeryEvidence}/held-inspection.json`;
  await (await download).saveAs(held);
  await page.reload();
  await page.evaluate(mountMaterialHistory);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByLabel("Open recipe, oven route or saved production run", {
      exact: true,
    })
    .setInputFiles(held);
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  for (let turn = 0; turn < 6; turn++) {
    const row = page.locator('[data-inspection-state="pending"]').first();
    await row.waitFor();
    const task = await row.getAttribute("data-inspection-task");
    await page
      .getByLabel("Inspection observation", { exact: true })
      .fill("Synthetic material-storage acceptance inspection.");
    await row
      .getByRole("button", {
        name: task.startsWith("load-hazelnut-b#") ? "Reject" : "Accept",
        exact: true,
      })
      .click();
    await page
      .getByLabel("Execution status", { exact: true })
      .filter({ hasText: turn === 5 ? "completed" : "awaiting-inspection" })
      .waitFor();
  }
  const final = await page
    .locator('[data-material-storage="hazelnut-batter-holding"]')
    .textContent();
  if (
    (await page
      .locator(
        '[data-material-storage="hazelnut-batter-holding"] [data-quantity="occupied"]',
      )
      .textContent()) !== "126000"
  )
    throw new Error("The final store lost the unportioned 126 g of batter.");
  const replayed = await inspectMaterialAt(page, "575", "0", "745000");
  if (replayed !== reserved)
    throw new Error(
      "Fresh continuation changed earlier material-store history.",
    );
  await page.screenshot({
    path: "historical-material-after-continuation.png",
    fullPage: true,
  });
  return {
    result: "passed",
    reserved,
    filled,
    final,
    freshHostPreservedHistory: true,
    taskSelection: true,
    remainderMg: 126000,
  };
}
async function inspectMaterialAt(page, at, occupied, reserved) {
  await page.getByLabel("Observation seconds", { exact: true }).fill(at);
  await page
    .getByRole("button", { name: "Inspect factory history", exact: true })
    .click();
  await page
    .locator(
      `[aria-label="Material storage history"][data-time="${Number(at) * 1e6}"]`,
    )
    .waitFor();
  const row = page.locator('[data-material-storage="hazelnut-batter-holding"]');
  if (
    (await row.locator('[data-quantity="occupied"]').textContent()) !==
      occupied ||
    (await row.locator('[data-quantity="reserved"]').textContent()) !== reserved
  )
    throw new Error(
      `Material occupancy and output reservations differ at ${at} seconds.`,
    );
  return row.textContent();
}
async function materialHistoryStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}
async function mountMaterialHistory() {
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

// Physics diagnostics render only in the workflow preview with ?evidence.
async function openPhysicsEvidence(page) {
  const url = new URL(page.url());
  if (url.searchParams.has("evidence")) {
    await page.reload();
    return;
  }
  url.searchParams.set("evidence", "");
  await page.goto(url.href);
}
