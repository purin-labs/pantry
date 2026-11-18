async function verifyGingerMilkTeaBrowser(page) {
  const evidence = new URL(page.url()).searchParams.get("evidence");
  if (evidence === null)
    throw new Error("Provide the ginger milk tea evidence URL.");
  await page.route("**/src/dev/workflow-preview.tsx", previewStyles);
  await page.reload();
  await page.evaluate(mountWorkflowSimulator, { kind: "preview" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByText("Individual recipes and logistics examples", { exact: true })
    .click();
  await page
    .getByLabel("Milk tea ginger simmer seconds", { exact: true })
    .fill("360");
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Tea orders", exact: true }),
    { value: "mixed-tea" },
  );
  await page
    .getByRole("button", { name: "Prepare mixed tea", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "milk-tea-recipe-inputs.png", fullPage: true });
  await page
    .getByRole("button", { name: "Prepare mixed tea", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page
    .locator(
      '[data-inspection-task="tea-batches#0/inspect-strained-tea"][data-inspection-state="pending"]',
    )
    .waitFor({ timeout: 120000 });
  await page
    .getByLabel("Inspection observation", { exact: true })
    .fill("Release black tea before cleaning and native milk tea staging.");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page
    .locator(
      '[data-task="milk-tea-batches#0/stage-pan-b"][data-kind="executing"]',
    )
    .waitFor({ timeout: 120000 });
  await page
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page
    .getByLabel("Execution status")
    .filter({ hasText: "paused" })
    .waitFor();
  await page
    .locator('[aria-label="Live accepted physics"][data-scene="ready"]')
    .waitFor();
  const paused = await download(page, "paused-pan-staging");
  const staging = paused.document.state.tasks.find(isFirstStagingTask);
  if (staging?.kind !== "executing")
    throw new Error("The browser did not pause native pan staging.");
  await page
    .getByLabel("Live accepted physics", { exact: true })
    .screenshot({ path: "pan-staging-paused.png" });
  await backToRecipes(page);
  await page
    .getByLabel("Open recipe, oven route or saved production run", {
      exact: true,
    })
    .setInputFiles({
      name: "paused-pan-staging.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(paused)),
    });
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  for (let batch = 0; batch < 2; batch++) {
    await pendingReview(page, batch);
    await page
      .getByLabel("Inspection observation", { exact: true })
      .fill("Synthetic on-time tea review");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
  }
  await completed(page);
  const authored = await download(page, "authored-completed");
  await page.screenshot({
    path: "milk-tea-authored-completed.png",
    fullPage: true,
  });
  await backToRecipes(page);

  const partial = await page.request.get(
    new URL(`${evidence}/mixed-late-held.json`, page.url()).href,
  );
  if (!partial.ok()) throw new Error("The held tea save is missing.");
  await page
    .getByLabel("Open recipe, oven route or saved production run", {
      exact: true,
    })
    .setInputFiles({
      name: "late-held.json",
      mimeType: "application/json",
      buffer: await partial.body(),
    });
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await pendingReview(page, 0);
  await page
    .getByText("Milk tea batch 1 · Extraction review", { exact: true })
    .waitFor();
  await page
    .getByText("Straining started 90 seconds late.", { exact: false })
    .waitFor();
  await page
    .getByText("Accept permits milk addition and finishing.", { exact: false })
    .waitFor();
  if (
    await page.getByRole("button", { name: "Accept", exact: true }).isEnabled()
  )
    throw new Error("A tea batch can be released without a disposition note.");
  await page.screenshot({ path: "milk-tea-late-restored.png", fullPage: true });
  await page
    .locator('[data-inspection-task="milk-tea-batches#0/inspect-strained-tea"]')
    .screenshot({ path: "mixed-tea-late-decision.png" });
  await page
    .getByLabel("Inspection observation", { exact: true })
    .fill("Discard this late batch. Synthetic acceptance decision.");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await pendingReview(page, 1);
  await page
    .getByLabel("Inspection observation", { exact: true })
    .fill("Release the second batch. Synthetic acceptance decision.");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await completed(page);
  const continued = await download(page, "continued-completed");
  await page.getByText("skipped", { exact: true }).first().waitFor();
  const result = await page.evaluate(compareRecipeRuns, {
    authored,
    continued,
    evidence,
  });
  await page.screenshot({
    path: "milk-tea-continued-completed.png",
    fullPage: true,
  });
  return {
    result: "passed",
    ...result,
    pausedNativeStagingReopened: true,
    downloads: [
      "paused-pan-staging.json",
      "authored-completed.json",
      "continued-completed.json",
    ],
  };
}
function isFirstStagingTask(task) {
  return task.id === "milk-tea-batches#0/stage-pan-b";
}
async function pendingReview(page, batch) {
  await page
    .locator(
      `[data-inspection-task="milk-tea-batches#${batch}/inspect-strained-tea"][data-inspection-state="pending"]`,
    )
    .waitFor();
}
async function completed(page) {
  await page
    .getByLabel("Execution status")
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 120000 });
}
async function download(page, name) {
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  const file = await event;
  const path = `${globalThis.bakeryEvidence}/${name}.json`;
  await file.saveAs(path);
  return await page.evaluate(readDownloadedRun, path);
}
async function readDownloadedRun(filePath) {
  const response = await fetch(`/@fs${filePath}`);
  if (!response.ok) throw new Error("The downloaded run is unavailable.");
  return response.json();
}
async function compareRecipeRuns({ authored, continued, evidence }) {
  const { canonicalJson } = await import("/@id/@seams/std");
  const expected = (
    await (await fetch(`${evidence}/mixed-restored.json`)).json()
  ).run;
  const original = (
    await (await fetch(`${evidence}/mixed-late-held.json`)).json()
  ).document.state;
  const first = authored.document.state;
  const next = continued.document.state;
  for (const state of [first, next]) {
    if (state.status.kind !== "completed")
      throw new Error("Tea production did not finish.");
    let mass = 0;
    for (const lot of state.lots)
      if (lot.remaining.unit === "milligram") mass += lot.remaining.amount;
    for (const event of state.events)
      if (
        event.kind === "quantity-reported" &&
        event.role !== "intermediate-stock" &&
        event.quantity.unit === "milligram"
      )
        mass += event.quantity.amount;
    if (mass !== 2_351_000) throw new Error("Tea material balance differs.");
  }
  let simmer = null;
  for (const workflow of first.definition.scenario.workflows)
    if (workflow.id === "ginger-milk-tea-batch")
      for (const task of workflow.tasks)
        if (task.key === "simmer-ginger") simmer = task.executor.duration;
  if (simmer !== 360_000_000)
    throw new Error("The selected ginger simmer did not reach execution.");
  let served = 0;
  let rejected = 0;
  for (const event of next.events) {
    if (event.kind !== "quantity-reported") continue;
    if (event.destination === "servings") served += event.quantity.amount;
    if (event.destination === "rejected-servings")
      rejected += event.quantity.amount;
  }
  if (served !== 4 || rejected !== 2)
    throw new Error(
      "The recorded decisions did not control service and discard.",
    );
  if (
    canonicalJson(next.lots) !== canonicalJson(expected.lots) ||
    canonicalJson(next.carriers) !== canonicalJson(expected.carriers)
  )
    throw new Error("Browser restore changed material or equipment custody.");
  if (
    next.identity.runId !== original.identity.runId ||
    next.identity.executionId === original.identity.executionId
  )
    throw new Error(
      "The browser did not create a fresh execution for this run.",
    );
  let milkRemaining = null;
  for (const lot of next.lots)
    if (lot.id === "stock-milk") milkRemaining = lot.remaining.amount;
  if (milkRemaining !== 180_000) throw new Error("Rejection consumed milk.");
  let skippedHeating = 0;
  for (const task of next.tasks) {
    if (!task.id.startsWith("milk-tea-batches#0/heat-and-stir-to-")) continue;
    if (task.kind !== "skipped")
      throw new Error("Rejected extract reached milk finishing.");
    skippedHeating += 1;
  }
  if (skippedHeating !== 2) throw new Error("Missing rejected heating steps.");
  return {
    served,
    rejected,
    massMg: 2_351_000,
    mixedTea: true,
    selectedSimmerSeconds: 360,
    exactContinuation: true,
    lateReviewVisible: true,
    rejectedMilkPreservedMg: 180_000,
    skippedHeatingVisible: true,
  };
}
verifyGingerMilkTeaBrowser;
