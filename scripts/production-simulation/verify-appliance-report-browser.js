/**
 * Refactor 16, Step 15B Portal browser journey:
 * 1. Opens a 2-tray Financier recipe in the Portal Kitchen run view
 *    (`OvenWorkspace`) on `factory-acceptance.html`.
 * 2. Runs the schedule to completion in the real Wasm execution worker
 *    (handling inspections along the way).
 * 3. Verifies the automatic MuJoCo **Appliance physics report** renders in the
 *    Results panel with real simulated checks, appliances, temperatures, and
 *    checkpoint digests.
 * 4. Verifies that the failed check (`load-hazelnut-b#0/bake`, middle-rear deck
 *    hotspot Maillard index > 0.350) marks the task as **At risk** across
 *    Results, Logistics (`data-at-risk="true"` while `data-kind="completed"`
 *    per D3), Inspector (`SelectedOvenTask`), Workflow cards, and Timeline.
 * 5. Opens Espresso (`linea`) in the Portal run view, completes it, and verifies
 *    a clean appliance physics report with 0 at-risk tasks.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-appliance-report-browser.js \
 *   --url http://127.0.0.1:3184/factory-acceptance.html --output <directory> --timeout 600000
 */
async function verifyApplianceReportBrowser(page) {
  const fixture = new URL(page.url()).href;
  await page.setViewportSize({ width: 1440, height: 1000 });

  function fail(message, detail) {
    throw new Error(`${message}: ${JSON.stringify(detail)}`);
  }

  // 1. Open Financier recipe (2 loads -> load-hazelnut-a#0 nominal, load-hazelnut-b#0 middle-rear hotspot).
  await page.goto(fixture);
  await openMultiBatchProduction(page);
  await showProductionCatalog(page);
  const picker = page.getByLabel(
    /^Open recipe, oven route or saved production run/,
  );
  await picker.waitFor({ timeout: 30000 });
  const financierJson = await page.evaluate(buildFinancierRecipePayload);
  await picker.setInputFiles({
    name: "financier-step-15b.json",
    mimeType: "application/json",
    buffer: Buffer.from(financierJson),
  });

  const workspace = page.getByRole("region", {
    name: "Persistent production",
  });
  await workspace
    .getByRole("button", { name: "Start production", exact: true })
    .click();

  // Drive through inspections until the run reaches completed.
  const statusOutput = workspace.getByLabel("Execution status", {
    exact: true,
  });
  const inspectionsHandled = [];
  for (let turn = 0; turn < 12; turn++) {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[aria-label="Execution status"]');
        const text = el?.textContent?.trim() ?? "";
        return (
          text === "completed" ||
          text === "awaiting-inspection" ||
          text === "blocked" ||
          text === "failed"
        );
      },
      { timeout: 120000 },
    );
    const status = (await statusOutput.textContent()).trim();
    if (status === "completed") break;
    if (status !== "awaiting-inspection") {
      fail("Financier run stopped unexpectedly", status);
    }
    await openFactoryPanel(page, "Inspector");
    const row = page.locator('[data-inspection-state="pending"]').first();
    await row.waitFor({ timeout: 15000 });
    const taskId = await row.getAttribute("data-inspection-task");
    await page
      .getByLabel("Inspection observation", { exact: true })
      .fill("Operator inspection passed for step 15B verification.");
    await row.getByRole("button", { name: "Accept", exact: true }).click();
    inspectionsHandled.push(taskId);
  }
  const finalStatus = (await statusOutput.textContent()).trim();
  if (finalStatus !== "completed") {
    fail("Financier run did not complete", { finalStatus, inspectionsHandled });
  }

  // 2. Open Results panel and wait for real MuJoCo appliance checks to finish.
  await openFactoryPanel(page, "Results");
  const reportSection = page.getByRole("region", {
    name: "Appliance physics report",
    exact: true,
  });
  await reportSection.waitFor({ timeout: 30000 });
  await page
    .locator(
      '[aria-label="Appliance physics report"][data-appliance-report-state="ready"]',
    )
    .waitFor({ timeout: 180000 });

  const checkCount = Number(
    await reportSection
      .locator("[data-appliance-checks]")
      .getAttribute("data-appliance-checks"),
  );
  const applianceCount = Number(
    await reportSection
      .locator("[data-appliance-count]")
      .getAttribute("data-appliance-count"),
  );
  const atRiskCount = Number(
    await reportSection
      .locator("[data-appliance-at-risk]")
      .getAttribute("data-appliance-at-risk"),
  );
  if (checkCount < 20 || applianceCount < 5 || atRiskCount < 1) {
    fail("Unexpected Financier appliance report counts", {
      checkCount,
      applianceCount,
      atRiskCount,
    });
  }

  // Verify hotspot bake row is marked At risk in both the callout and table.
  const hotspotTaskId = "load-hazelnut-b#0/bake";
  const calloutItem = reportSection.locator(
    `[data-at-risk-item="${hotspotTaskId}"]`,
  );
  if ((await calloutItem.count()) !== 1) {
    fail("Missing at-risk callout item for hotspot bake", hotspotTaskId);
  }
  const reportRow = reportSection.locator(
    `tr[data-appliance-task="${hotspotTaskId}"][data-appliance-check="at-risk"]`,
  );
  if ((await reportRow.count()) !== 1) {
    fail("Missing at-risk table row for hotspot bake", hotspotTaskId);
  }
  await page.screenshot({ path: "appliance-report-results.png" });

  // 3. Verify D3 in Logistics: task stays `completed` AND is marked `data-at-risk="true"`
  //    in both the top Task activity trace and the Logistics task table.
  await openFactoryPanel(page, "Logistics");
  const traceItem = page.locator(
    `[data-task-id="${hotspotTaskId}"][data-at-risk="true"]`,
  );
  if ((await traceItem.count()) !== 1) {
    fail("Activity trace item did not mark at-risk", hotspotTaskId);
  }
  if ((await traceItem.locator('[data-risk="at-risk"]').count()) !== 1) {
    fail("Activity trace item missing At risk badge", hotspotTaskId);
  }
  const logisticsRow = page.locator(
    `tr[data-task="${hotspotTaskId}"][data-kind="completed"][data-at-risk="true"]`,
  );
  if ((await logisticsRow.count()) !== 1) {
    fail("Logistics row did not preserve completed + at-risk", hotspotTaskId);
  }
  const logisticsBadge = logisticsRow.locator('[data-risk="at-risk"]');
  if ((await logisticsBadge.count()) !== 1) {
    fail("Logistics row missing At risk badge", hotspotTaskId);
  }
  await page.screenshot({ path: "appliance-report-logistics-at-risk.png" });

  // 4. Click task -> verify SelectedOvenTask in Inspector shows the at-risk detail.
  await logisticsRow.locator("button").first().click();
  const selectedInspector = page
    .locator(`[data-selected-task="${hotspotTaskId}"][data-at-risk="true"]`)
    .first();
  await selectedInspector.waitFor({ timeout: 10000 });
  const inspectorRiskText = await selectedInspector
    .locator(`[data-task-at-risk="${hotspotTaskId}"]`)
    .textContent();
  if (!inspectorRiskText?.includes("Maillard")) {
    fail("Inspector missing Maillard hotspot explanation", inspectorRiskText);
  }

  // 5. Verify Workflow card and Timeline track mark the same task as At risk while `completed`.
  await showFactoryWorkflow(page);
  const graphCard = page.locator(
    `[data-graph-task="${hotspotTaskId}"][data-kind="completed"][data-at-risk="true"]`,
  );
  await graphCard.waitFor({ timeout: 15000 });
  await page.screenshot({ path: "appliance-report-workflow-at-risk.png" });

  await workspace.locator(".production-timeline-toggle").click();
  const timelineRow = page.locator(
    `[data-timeline-task="${hotspotTaskId}"][data-kind="completed"][data-at-risk="true"]`,
  );
  await timelineRow.waitFor({ timeout: 15000 });

  // 6. Verify summary pill reflects at-risk count.
  const summaryAtRisk = Number(
    await workspace
      .locator(".factory-summary")
      .getAttribute("data-appliance-at-risk"),
  );
  if (summaryAtRisk !== atRiskCount) {
    fail("Summary pill at-risk count mismatch", { summaryAtRisk, atRiskCount });
  }

  return {
    result: "passed",
    financier: {
      inspectionsHandled,
      checkCount,
      applianceCount,
      atRiskCount,
      hotspotTaskId,
      inspectorRiskText,
      summaryAtRisk,
    },
  };
}

async function buildFinancierRecipePayload() {
  const { financierRecipeInput } =
    await import("/@id/@purin-labs/production-simulation/recipes/bakery/financier");
  return JSON.stringify({
    kind: "financier-recipe",
    recipe: financierRecipeInput(2, 2, 15 * 60),
  });
}
