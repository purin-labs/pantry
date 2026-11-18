/**
 * Recurring financier decision: under the same demand, does one more cooling
 * rack position or one more financier tray raise output? Runs three shifts in
 * the Portal, explains a waiting batch from history, keeps and exports the
 * comparison, then reopens a saved shift in a fresh page with the exported
 * comparison and checks that its result is unchanged.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-financier-decision-browser.js \
 *   --url http://127.0.0.1:<port>/factory-acceptance.html --output <absolute directory>
 */
async function prepareFinancierShift(page, input) {
  const form = page.getByRole("form", {
    name: "Recurring financier production",
    exact: true,
  });
  if (!(await form.isVisible()))
    await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await form.getByLabel(/^Minutes between batches/).fill(String(input.minutes));
  await form.getByLabel(/^Bakers/).fill(String(input.bakers));
  await form.getByLabel(/^Financier trays/).fill(String(input.trays));
  await form.getByLabel(/^Cooling rack positions/).fill(String(input.cooling));
  await form
    .getByRole("button", { name: "Prepare financier production", exact: true })
    .click();
  const workspace = page.getByRole("region", {
    name: "Persistent production",
    exact: true,
  });
  await workspace
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await workspace
    .locator('[aria-label="Execution status"]')
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 60000 });
  return workspace;
}

async function keepFinancierResult(workspace) {
  await workspace.getByRole("button", { name: "Results", exact: true }).click();
  const comparison = workspace.getByRole("region", {
    name: "Financier comparison",
    exact: true,
  });
  await comparison
    .getByRole("button", { name: "Keep this result", exact: true })
    .click();
  return comparison;
}

async function closeFinancierShift(workspace) {
  await backToRecipes(workspace.page());
}

async function downloadFinancierFile(page, trigger, name) {
  const downloadEvent = page.waitForEvent("download");
  await trigger.click();
  const download = await downloadEvent;
  const path = globalThis.bakeryEvidence + "/" + name;
  await download.saveAs(path);
  return path;
}

async function keptValue(comparison, label, column) {
  const row = comparison
    .getByRole("table", { name: "Kept financier scenarios" })
    .getByRole("row")
    .filter({
      has: comparison
        .page()
        .getByRole("rowheader", { name: label, exact: true }),
    });
  return (await row.getByRole("cell").nth(column).textContent()).trim();
}

async function verifyFinancierDecisionBrowser(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(new URL("/factory-acceptance.html", page.url()).href);
  const baseline = { minutes: 45, bakers: 1, trays: 2, cooling: 2 };
  const cooling = { ...baseline, cooling: 3 };
  const trays = { ...baseline, trays: 3 };

  // A: the baseline shift. Explain a waiting batch from accepted history.
  let workspace = await prepareFinancierShift(page, baseline);
  await workspace.locator('.factory-pane[data-scene="ready"]').waitFor();
  await workspace.getByRole("button", { name: "History", exact: true }).click();
  await workspace
    .getByLabel("Observation seconds", { exact: true })
    .fill("9000");
  await workspace
    .getByRole("button", { name: "Inspect factory history", exact: true })
    .click();
  await workspace
    .getByRole("button", {
      name: "Viewing history · Return to live state",
      exact: true,
    })
    .waitFor();
  await workspace
    .getByRole("button", { name: "Logistics", exact: true })
    .click();
  await workspace
    .getByRole("region", { name: "Batches", exact: true })
    .getByRole("button", { name: "Batch 3", exact: true })
    .click();
  const why = workspace.getByRole("region", {
    name: "Why this waits",
    exact: true,
  });
  await why.waitFor();
  const missing = await why
    .locator("[data-wait-missing]")
    .getAttribute("data-wait-missing");
  const constraint = await why
    .locator("[data-wait-constraint]")
    .getAttribute("data-wait-constraint");
  if (missing !== "clean-trays" || constraint !== "loaded-grids")
    throw new Error(
      `Batch 3 should wait for a clean tray behind the cooling rack, not ${missing} behind ${constraint}.`,
    );
  const chain = await why.locator("ol li").allTextContents();
  await workspace
    .getByRole("navigation", { name: "Factory canvas view" })
    .getByRole("button", { name: "Split", exact: true })
    .click();
  await workspace
    .locator('.factory-pane[data-camera="floor"][data-scene="ready"]')
    .waitFor();
  await page.screenshot({ path: "output/playwright/p70-financier-why.png" });
  await workspace
    .getByRole("button", {
      name: "Viewing history · Return to live state",
      exact: true,
    })
    .click();
  await keepFinancierResult(workspace);
  await closeFinancierShift(workspace);

  // B: one more cooling rack position. Save this shift for the restore check.
  workspace = await prepareFinancierShift(page, cooling);
  await keepFinancierResult(workspace);
  await workspace.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await downloadFinancierFile(
    page,
    workspace.getByRole("button", { name: "Download save file", exact: true }),
    "p70-financier-cooling-run.json",
  );
  await closeFinancierShift(workspace);

  // C: one more financier tray.
  workspace = await prepareFinancierShift(page, trays);
  const comparison = await keepFinancierResult(workspace);
  const decisions = await comparison
    .getByRole("list", { name: "Comparison decision" })
    .getByRole("listitem")
    .allTextContents();
  const perHour = [];
  for (const column of [0, 1, 2])
    perHour.push(
      Number(
        await keptValue(comparison, "Finished financiers per hour", column),
      ),
    );
  if (!(perHour[1] > perHour[0] * 1.2))
    throw new Error(
      `One more cooling position should raise output: ${perHour}.`,
    );
  if (Math.abs(perHour[2] - perHour[0]) > perHour[0] * 0.01)
    throw new Error(`One more tray should not change output: ${perHour}.`);
  await page.screenshot({
    path: "output/playwright/p70-financier-comparison.png",
  });
  const exported = await downloadFinancierFile(
    page,
    comparison.getByRole("button", { name: "Export comparison", exact: true }),
    "p70-financier-comparison.json",
  );

  // A fresh page and worker: open the exported comparison and the saved shift.
  await page.reload();
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByLabel("Open recipe, oven route or saved production run", {
      exact: true,
    })
    .setInputFiles(saved);
  workspace = page.getByRole("region", {
    name: "Persistent production",
    exact: true,
  });
  await workspace
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await workspace
    .locator('[aria-label="Execution status"]')
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 60000 });
  await workspace.getByRole("button", { name: "Results", exact: true }).click();
  const reopened = workspace.getByRole("region", {
    name: "Financier comparison",
    exact: true,
  });
  await reopened
    .getByLabel("Open comparison", { exact: true })
    .setInputFiles(exported);
  const match = reopened.locator("[data-kept-match]");
  await match.waitFor();
  const matchText = (await match.textContent()).trim();
  if (
    (await match.getAttribute("data-kept-match")) !== "B" ||
    !matchText.includes("same result")
  )
    throw new Error(
      `The restored shift does not match kept scenario B: ${matchText}`,
    );
  await workspace.locator('.factory-pane[data-scene="ready"]').waitFor();
  await page.screenshot({
    path: "output/playwright/p70-financier-restored.png",
  });
  return {
    result: "passed",
    question:
      "What limits financier output, and which small change improves it?",
    scenarios: { A: baseline, B: cooling, C: trays },
    finishedPerHour: { A: perHour[0], B: perHour[1], C: perHour[2] },
    decisions,
    waitingBatch: { batch: "Batch 3", at: 9000, missing, constraint, chain },
    restored: matchText,
    saved,
    exported,
  };
}
