async function verifyOvenAuthoringBrowser(page) {
  const fixtureUrl =
    new URL(page.url()).searchParams.get("fixture") ?? "http://127.0.0.1:5197";
  const fixture = await (
    await page.request.get(`${fixtureUrl}/fixture.json`)
  ).json();
  globalThis.ovenAuthorFixture = fixtureUrl;
  await page.route("**/src/dev/workflow-preview.tsx*", serveAuthorStyles);
  await page.route(
    "**/v1/control/organisations/oven-authoring-acceptance/commerce/**",
    forwardAuthorRequest,
  );
  await page.reload();
  await page.addScriptTag({
    content: `${authorMutation.toString()}\nwindow.ovenAuthorMutation = authorMutation;`,
  });
  await page.evaluate(mountAuthorWorkspace, fixture.organisationId);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openScenarios(page);
  await page
    .getByRole("region", { name: "Find a saved procedure", exact: true })
    .getByRole("button", {
      name: "Open Financier finishing · assumed timings",
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Procedure loaded" })
    .waitFor();
  await openAuthorProduction(page);
  await editInputs(page);
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Production route", exact: true }),
    { value: "oven-rack" },
  );
  const author = page.getByRole("region", {
    name: "Author persistent oven route",
    exact: true,
  });
  await author
    .getByRole("textbox", { name: "Oven route name", exact: true })
    .fill("Shared native oven route");
  await author
    .getByRole("textbox", { name: "Oven route note", exact: true })
    .fill("Baker 2 waits for batch A to reach the oven rack.");
  // A task cannot wait for its own downstream loading operation.
  await author
    .getByText("Additional task prerequisites (0)", { exact: true })
    .click();
  await author.getByLabel("A · Load oven", { exact: true }).check();
  await author
    .getByRole("button", { name: "Review oven route", exact: true })
    .click();
  await author
    .getByRole("status")
    .filter({ hasText: "must not form a cycle" })
    .waitFor();
  if (
    await author
      .getByRole("button", { name: "Save oven scenario copy", exact: true })
      .isEnabled()
  )
    throw new Error("A cyclic definition can be saved.");
  await author.getByLabel("A · Load oven", { exact: true }).uncheck();
  await chooseOption(
    page,
    author.getByRole("combobox", {
      name: "Oven route manual task",
      exact: true,
    }),
    { value: "batch:B:process:stage" },
  );
  await chooseOption(
    page,
    author.getByRole("combobox", { name: "Assigned baker", exact: true }),
    { value: "2" },
  );
  await author
    .getByLabel("Earliest task start (seconds after 06:00)", { exact: true })
    .fill("150");
  await author.getByLabel("A · Place on oven rack", { exact: true }).check();
  await author
    .getByText("Additional task prerequisites (1)", { exact: true })
    .click();
  await author
    .getByRole("button", { name: "Review oven route", exact: true })
    .click();
  await author
    .getByRole("status")
    .filter({ hasText: "Route reviewed" })
    .waitFor({ timeout: 120000 });
  const id = await author
    .getByLabel("Oven scenario ID", { exact: true })
    .textContent();
  await author
    .getByRole("button", { name: "Save oven scenario copy", exact: true })
    .click();
  await author
    .getByRole("status")
    .filter({ hasText: "Saved and verified" })
    .waitFor();
  await author
    .getByRole("status")
    .filter({ hasText: "Saved and verified" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "shared-oven-authoring.png", fullPage: true });

  await page.reload();
  await page.addScriptTag({
    content: `${authorMutation.toString()}\nwindow.ovenAuthorMutation = authorMutation;`,
  });
  await page.evaluate(mountAuthorWorkspace, fixture.organisationId);
  await openAuthorProduction(page);
  await editInputs(page);
  await page
    .getByRole("region", {
      name: "Find a saved production scenario",
      exact: true,
    })
    .getByRole("button", { name: "Open Shared native oven route", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await waitForRunState(page, runCompleted);
  const pending = downloadFactorySave(page);
  const finalPath = `${globalThis.bakeryEvidence}/authored-oven-run.json`;
  await (await pending).saveAs(finalPath);
  await page.screenshot({ path: "shared-oven-completed.png", fullPage: true });
  const storage = await (
    await page.request.get(`${fixtureUrl}/evidence.json`)
  ).json();
  const result = await page.evaluate(inspectAuthorResult, {
    finalPath,
    storage,
    id,
  });
  return {
    result: "passed",
    ...result,
    cycleRefused: true,
    realStorageReads: storage.reads,
    finalPath,
  };
}

async function serveAuthorStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}
async function forwardAuthorRequest(route) {
  const path = new URL(route.request().url()).pathname;
  const response = await route.fetch({
    url: `${globalThis.ovenAuthorFixture}${path}`,
  });
  await route.fulfill({ response });
}
async function mountAuthorWorkspace(organisationId) {
  const { initializeBrowserValidators } =
    await import("/@id/@purin-labs/commerce-contracts/browser-validators");
  await initializeBrowserValidators();
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: WorkflowSimulatorRoute } =
    await import("/src/features/workflow-simulator/route.tsx");
  document.getElementById("root").remove();
  const host = document.createElement("div");
  document.body.append(host);
  ReactDOM.createRoot(host).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(WorkflowSimulatorRoute, {
        connection: {
          kind: "workspace",
          organisationId,
          canManage: true,
          mutate: window.ovenAuthorMutation,
        },
      }),
    ),
  );
}
// Installed separately so the fixture uses a standalone transport function.
async function authorMutation(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
async function openAuthorProduction(page) {
  await openMultiBatchProduction(page);
  await page
    .getByRole("button", { name: "Edit scenario", exact: true })
    .waitFor();
}
async function inspectAuthorResult({ finalPath, storage, id }) {
  const { parseProductionScenario } =
    await import("/@id/@purin-labs/bakery-model/bakery-production-scenario");
  if (storage.writes.length !== 1)
    throw new Error("The UI must create exactly one immutable scenario.");
  const definition = parseProductionScenario(storage.writes[0]);
  if (definition?.route !== "oven-rack" || definition.id !== id)
    throw new Error("The saved oven route is invalid.");
  const saved = await (await fetch(`/@fs/${finalPath}`)).json();
  const run = saved.document.state;
  if (
    run.status.kind !== "completed" ||
    saved.document.bundle.id !== definition.executionBundleId
  )
    throw new Error(
      "The authored run did not finish on its pinned execution build.",
    );
  let native = null;
  let staged = null;
  let worker = null;
  for (const task of run.tasks) {
    if (task.id === "batch-A#0/oven-rack") native = task;
    if (task.id === "batch-B#0/stage") staged = task;
  }
  for (const event of run.events)
    if (event.kind === "worker-assigned" && event.task === "batch-B#0/stage")
      worker = event.worker;
  if (
    native?.kind !== "completed" ||
    staged?.kind !== "completed" ||
    staged.startedAt < native.completedAt ||
    staged.startedAt < 150_000_000 ||
    worker !== "human-2"
  )
    throw new Error(
      "The authored native dependency or earliest start was lost.",
    );
  if (
    definition.cell.fixture !== "persistent-oven-rack/1" ||
    definition.assignments.length !== 0 ||
    definition.settings.ovenTrays !== 1 ||
    definition.settings.traysPerBatch !== 1
  )
    throw new Error("The authored fixture does not match the one-tray route.");
  return {
    scenarioId: id,
    executionBundleId: definition.executionBundleId,
    simulatedSeconds: run.position.time / 1_000_000,
    nativeDependency: {
      completedAt: native.completedAt,
      startedAt: staged.startedAt,
      worker,
    },
    definition,
    artifactCount: saved.artifacts.length,
  };
}
