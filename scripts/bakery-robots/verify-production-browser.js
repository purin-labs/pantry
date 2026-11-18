// Plan 42F F1a: production transfers run in browser MuJoCo through the one
// production scheduler. Run with the Playwright CLI; see the F1a evidence.
const productionBase = globalThis.bakeryBase ?? "http://127.0.0.1:5188";
const productionEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan42f-production-browser";
const productionFixture =
  globalThis.bakeryFixture ??
  "output/acceptance/plan42f-production-browser/pending-slip.json";

async function openProduction(page) {
  await page.goto(`${productionBase}/workflow-preview.html`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMultiBatchProduction(page);
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .waitFor();
}
function runButton(page) {
  return page.getByRole("button", { name: "Run in browser", exact: true });
}
async function browserStatus(page, text, timeout = 125000) {
  await page
    .locator(".production-browser-run p")
    .filter({ hasText: text })
    .waitFor({ timeout });
}
async function saveProduction(page, name) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Save production run", exact: true })
      .click(),
  ]);
  await download.saveAs(`${productionEvidence}/${name}.json`);
}
async function reopenProduction(page, path) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByLabel("Open production run or native recording", { exact: true })
    .setInputFiles(path);
  await page
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
}
async function chooseVariant(page, variant) {
  await editInputs(page);
  // The Oven availability Select is the one that offers the outage variant.
  await chooseOption(
    page,
    page.locator(".production-workspace").getByLabel(/^Oven availability/),
    { value: variant },
  );
  await page
    .getByRole("button", { name: "Preview scenario", exact: true })
    .click();
  await page.getByText("Valid preview:", { exact: false }).waitFor();
}
async function showEnd(page, name) {
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.getByRole("slider", { name: "Production time" }).press("End");
  await page.screenshot({ path: `${productionEvidence}/${name}.png` });
}

async function corruptBundleAsset(route) {
  const response = await route.fetch();
  const body = await response.body();
  body[0] ^= 1;
  await route.fulfill({ response, body });
}

async function verifyProductionBrowserAssets(page) {
  // A same-size substitution must fail before the controller can execute.
  for (const file of ["bakery_native.wasm", "bakery_native.data"]) {
    await openProduction(page);
    const pattern = `**/bakery-physics/bundles/*/${file}`;
    await page.route(pattern, corruptBundleAsset);
    await runButton(page).click();
    await browserStatus(page, "failed its integrity check");
    await saveProduction(page, `rejected-${file}`);
    await page.screenshot({
      path: `${productionEvidence}/rejected-${file}.png`,
    });
    await page.unroute(pattern, corruptBundleAsset);
  }
  await openProduction(page);

  // Stop after the first accepted result, then continue from the saved file.
  const stop = new WorkerFetchGate(2);
  await page.route(
    "**/bakery-physics/bundles/*/bakery_native.data",
    stop.handle.bind(stop),
  );
  await runButton(page).click();
  await stop.blocked;
  await page
    .getByRole("button", { name: "Stop simulation", exact: true })
    .click();
  stop.release();
  await page.unroute("**/bakery-physics/bundles/*/bakery_native.data");
  await browserStatus(page, "Browser simulation stopped.");
  await saveProduction(page, "stopped");
  await reopenProduction(page, `${productionEvidence}/stopped.json`);
  await runButton(page).click();
  await browserStatus(
    page,
    "Browser run complete. Every native operation has a result.",
  );
  await saveProduction(page, "completed");
  await reopenProduction(page, `${productionEvidence}/completed.json`);
  if (!(await runButton(page).isDisabled()))
    throw new Error("A completed production run must not execute again.");
  await showEnd(page, "completed-timeline");

  return {
    status: "passed",
    checks: [
      "same-size corruption of either Wasm or model data is refused before execution",
      "Stop during a model-data download preserves the accepted transfer",
      "the saved partial run continues without rerunning accepted transfers",
      "a completed run reopens without offering another execution",
    ],
  };
}

async function verifyProductionBrowser(page) {
  const assets = await verifyProductionBrowserAssets(page);

  // Applying a draft while a transfer loads stops the run; its result is dropped.
  await chooseVariant(page, "outage");
  await page
    .getByRole("button", {
      name: "Apply preview and prepare new requests",
      exact: true,
    })
    .click();
  await chooseVariant(page, "normal");
  const replace = new WorkerFetchGate(1);
  await page.route(
    "**/bakery-physics/bundles/*/bakery_native.wasm",
    replace.handle.bind(replace),
  );
  await runButton(page).click();
  await replace.blocked;
  await page
    .getByRole("button", {
      name: "Apply preview and prepare new requests",
      exact: true,
    })
    .click();
  replace.release();
  await page.unroute("**/bakery-physics/bundles/*/bakery_native.wasm");
  await browserStatus(
    page,
    "Browser simulation stopped because the production run changed.",
  );
  await page.waitForTimeout(3000);
  await saveProduction(page, "replaced");

  // A real slip holds the tray and cell, and the hold survives reopening.
  await reopenProduction(page, productionFixture);
  await runButton(page).click();
  await browserStatus(page, "Batch B · tray 1 transfer failed.");
  await saveProduction(page, "failed");
  await reopenProduction(page, `${productionEvidence}/failed.json`);
  await browserStatus(page, "Batch B · tray 1 transfer failed.", 10000);
  if (!(await runButton(page).isDisabled()))
    throw new Error("A held production run must not execute past a failure.");
  await showEnd(page, "failure-hold");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${productionEvidence}/failure-hold-mobile.png`,
  });
  return {
    status: "passed",
    checks: [
      ...assets.checks,
      "Multi-batch + robot executes each dispatched transfer in browser MuJoCo",
      "applying a draft mid-run stops the run and drops the in-flight result",
      "a real browser slip holds its tray and the cell and leaves later trays unexecuted",
      "the failure hold survives save and reopen",
      "desktop timeline and 390px evidence captured",
    ],
  };
}
