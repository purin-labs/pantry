async function verifyBlackSesameBrowser(page) {
  const evidence = new URL(page.url()).searchParams.get("evidence");
  if (evidence === null)
    throw new Error("Provide the black sesame evidence URL.");
  await page.route("**/src/dev/workflow-preview.tsx", previewStyles);
  await page.reload();
  await page.evaluate(mountWorkflowSimulator, { kind: "preview" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page
    .getByText(
      "Black Sesame Milk · WSG60, Vitamix Quiet One & Severin SM 3587",
      { exact: true },
    )
    .click();
  await page
    .getByLabel("Cooling minutes per sesame batch", { exact: true })
    .fill("30");
  await page
    .getByRole("button", { name: "Prepare black sesame milk", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "sesame-recipe-inputs.png", fullPage: true });
  await page
    .getByRole("button", { name: "Prepare black sesame milk", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await completed(page);
  const authored = await download(page, "authored-completed");
  await page.screenshot({
    path: "sesame-authored-completed.png",
    fullPage: true,
  });
  await backToRecipes(page);

  const partial = await page.request.get(
    new URL(`${evidence}/partial-bottle.json`, page.url()).href,
  );
  if (!partial.ok()) throw new Error("The partial bottle save is missing.");
  // The picker's label also carries a hint line, so match its title only.
  await page
    .getByLabel("Open recipe, oven route or saved production run")
    .setInputFiles({
      name: "partial-bottle.json",
      mimeType: "application/json",
      buffer: await partial.body(),
    });
  const start = page.getByRole("button", {
    name: "Continue saved run",
    exact: true,
  });
  await start.waitFor();
  if (!(await start.isEnabled()))
    throw new Error("The recipe cannot continue from its saved bottle state.");
  await page.screenshot({ path: "sesame-reopened-review.png", fullPage: true });
  await start.click();
  await completed(page);
  const continued = await download(page, "continued-completed");
  const result = await page.evaluate(compareRecipeRuns, {
    authored,
    continued,
    evidence,
  });
  await page.screenshot({
    path: "sesame-continued-completed.png",
    fullPage: true,
  });
  return { result: "passed", ...result, authored, continued };
}
async function completed(page) {
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "completed" })
    .waitFor();
}
async function download(page, name) {
  const file = page.getByRole("button", {
    name: "Download save file",
    exact: true,
  });
  if (!(await file.isVisible()))
    await page
      .getByRole("button", { name: "Save", exact: true, expanded: false })
      .click();
  const pending = page.waitForEvent("download");
  await file.click();
  const path = `${globalThis.bakeryEvidence}/${name}.json`;
  await (await pending).saveAs(path);
  return path;
}
async function compareRecipeRuns({ authored, continued, evidence }) {
  const { canonicalJson } = await import("/@id/@purin-labs/std");
  const first = (await (await fetch(`/@fs/${authored}`)).json()).document.state;
  const next = (await (await fetch(`/@fs/${continued}`)).json()).document.state;
  const expected = (await (await fetch(`${evidence}/completed.json`)).json())
    .document.state;
  const original = (
    await (await fetch(`${evidence}/partial-bottle.json`)).json()
  ).document.state;
  for (const state of [first, next]) {
    if (state.status.kind !== "completed")
      throw new Error("Drink production did not finish.");
    let served = 0;
    let mass = 0;
    for (const event of state.events) {
      if (event.kind !== "quantity-reported") continue;
      if (event.destination === "drinks-served")
        served += event.quantity.amount;
      if (
        event.quantity.unit === "milligram" &&
        event.role !== "intermediate-stock"
      )
        mass += event.quantity.amount;
    }
    for (const lot of state.lots)
      if (lot.remaining.unit === "milligram") mass += lot.remaining.amount;
    if (served !== 12 || mass !== 4_084_000)
      throw new Error("Served drinks or material balance differs.");
  }
  let coolingDuration = null;
  for (const workflow of first.definition.scenario.workflows)
    if (workflow.id === "sesame-batch")
      for (const task of workflow.tasks)
        if (task.key === "cool-in-bath")
          coolingDuration = task.executor.duration;
  if (coolingDuration !== 1_800_000_000)
    throw new Error("The authored cooling duration did not reach execution.");
  if (canonicalJson(next.lots) !== canonicalJson(expected.lots))
    throw new Error(
      "Browser continuation changed bottle quantities or lineage.",
    );
  if (
    next.identity.runId !== original.identity.runId ||
    next.identity.executionId === original.identity.executionId
  )
    throw new Error(
      "The recipe did not continue with fresh execution identity.",
    );
  const bottles = [];
  for (const lot of next.lots)
    if (lot.product === "concentrate")
      bottles.push({
        id: lot.id,
        storage: lot.holder.storage,
        remainingMg: lot.remaining.amount,
      });
  return {
    drinksServed: 12,
    massMg: 4_084_000,
    exactBottleContinuation: true,
    editedCoolingMinutes: 30,
    bottles,
  };
}
verifyBlackSesameBrowser;
