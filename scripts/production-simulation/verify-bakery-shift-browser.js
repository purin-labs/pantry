async function verifyBakeryShiftBrowser(page) {
  globalThis.ovenRecipeArchive = new Map();
  globalThis.ovenRecipeLoseReply = true;
  await page.route(
    "**/v1/control/organisations/oven-ui-acceptance/bakery/runs**",
    recipeArchiveRequest,
  );
  await page.route("**/src/dev/workflow-preview.tsx", serveOvenWorkspaceStyles);
  await page.reload();
  await installRecipeMutation(page);
  await page.evaluate(mountConnectedOvenWorkspace);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page.getByLabel("Financier trays", { exact: true }).fill("2");
  await page.getByLabel("Milk tea batches", { exact: true }).fill("2");
  await page
    .getByRole("form", { name: "Bakery shift", exact: true })
    .screenshot({ path: "bakery-shift-author.png" });
  await page
    .getByRole("button", { name: "Prepare bakery shift", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page
    .locator(
      '[data-task="milk-tea-batches#0/stage-pan-b"][data-kind="executing"]',
    )
    .first()
    .waitFor({ timeout: 120000 });
  await page
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "paused" })
    .waitFor();
  await page
    .getByRole("region", { name: "Production overview", exact: true })
    .screenshot({ path: "shift-paused-overview.png" });
  await page
    .locator('[aria-label="Live accepted physics"][data-scene="ready"]')
    .waitFor();
  await page
    .getByLabel("Live accepted physics", { exact: true })
    .screenshot({ path: "shift-native-staging.png" });
  await saveShared(page, "Bakery MVP in progress", true);
  const originalId = [...globalThis.ovenRecipeArchive.keys()][0];
  const original = globalThis.ovenRecipeArchive.get(originalId).content;
  await reopenShared(page, "Bakery MVP in progress");
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  for (let index = 0; index < 6; index++) {
    const row = page.locator('[data-inspection-state="pending"]').first();
    await row.waitFor({ timeout: 120000 });
    const task = await row.getAttribute("data-inspection-task");
    const decision =
      task === "milk-tea-batches#0/inspect-strained-tea" ? "Reject" : "Accept";
    await page
      .getByLabel("Inspection observation", { exact: true })
      .fill(
        `${decision}: synthetic MVP inspection. Discard rejected product and complete cleanup.`,
      );
    if (decision === "Reject")
      await row.screenshot({ path: "shift-reject-extract.png" });
    await row.getByRole("button", { name: decision, exact: true }).click();
  }
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 120000 });
  await saveShared(page, "Bakery MVP completed", false);
  if (globalThis.ovenRecipeArchive.size !== 2)
    throw new Error("The shift did not keep two immutable shared snapshots.");
  if (globalThis.ovenRecipeArchive.get(originalId).content !== original)
    throw new Error("Continuation changed the shared source snapshot.");
  await reopenShared(page, "Bakery MVP completed");
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "completed" })
    .waitFor();
  const file = await saveOvenDownload(page, "bakery-mvp-completed");
  const checked = await page.evaluate(checkShift, file);
  await page
    .getByRole("region", { name: "Production overview", exact: true })
    .screenshot({ path: "shift-completed-overview.png" });
  return {
    result: "passed",
    ...checked,
    sharedPauseAndCompletion: true,
    uncertainSaveRecovered: true,
    originalSnapshotUnchanged: true,
  };
}
async function saveShared(page, name, lostReply) {
  const shared = page.getByRole("region", {
    name: "Workspace saved runs",
    exact: true,
  });
  if (!(await shared.isVisible()))
    await page.getByText("Shared production runs", { exact: true }).click();
  await shared.getByLabel("Run name (required)").fill(name);
  await shared
    .getByRole("button", { name: "Review save", exact: true })
    .click();
  await shared
    .getByRole("button", { name: "Confirm save", exact: true })
    .click();
  if (lostReply) {
    await shared
      .getByRole("status")
      .filter({ hasText: "save response is uncertain" })
      .waitFor();
    await shared.getByRole("button", { name: /^Check saved run / }).click();
    await shared
      .getByRole("status")
      .filter({ hasText: "verified by exact readback" })
      .waitFor();
  } else
    await shared.getByRole("status").filter({ hasText: "verified" }).waitFor();
  await shared.screenshot({
    path: lostReply
      ? "shift-shared-save-recovered.png"
      : "shift-shared-save-completed.png",
  });
}
async function reopenShared(page, name) {
  await page.reload();
  await installRecipeMutation(page);
  await page.evaluate(mountConnectedOvenWorkspace);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page.getByText("Shared production runs", { exact: true }).click();
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  if (
    await page
      .getByRole("button", { name: "Continue saved run", exact: true })
      .isDisabled()
  )
    throw new Error("Shared open must await explicit continuation.");
}
async function checkShift(path) {
  const response = await fetch(`/@fs/${path}`);
  const saved = await response.json();
  const state = saved.document.state;
  if (
    state.definition.scenario.id !== "bakery-shift" ||
    state.status.kind !== "completed"
  )
    throw new Error("The wrong shift finished.");
  let mass = 0;
  let packed = 0;
  let served = 0;
  let rejected = 0;
  for (const lot of state.lots)
    if (lot.remaining.unit === "milligram") mass += lot.remaining.amount;
  for (const event of state.events) {
    if (event.kind !== "quantity-reported") continue;
    if (event.destination === "packed-pieces") packed += event.quantity.amount;
    if (event.destination === "servings") served += event.quantity.amount;
    if (event.destination === "rejected-servings")
      rejected += event.quantity.amount;
    if (
      event.role !== "intermediate-stock" &&
      event.quantity.unit === "milligram"
    )
      mass += event.quantity.amount;
  }
  if (mass !== 2374667 || packed !== 15 || served !== 2 || rejected !== 2)
    throw new Error("Shift material or output differs.");
  for (const carrier of state.carriers)
    if (carrier.bound !== null)
      throw new Error("Cleanup left equipment reserved.");
  return {
    packed,
    served,
    rejected,
    massMg: mass,
    executionBundle: saved.document.bundle.id,
  };
}
async function recipeArchiveRequest(route) {
  const request = route.request();
  const url = new URL(request.url());
  const prefix = "/v1/control/organisations/oven-ui-acceptance/bakery/runs";
  const id = url.pathname.slice(prefix.length + 1);
  const archive = globalThis.ovenRecipeArchive;
  if (request.method() === "POST") {
    const { expectedId, name, document } = request.postDataJSON();
    const content = JSON.stringify({ name, document });
    const summary = {
      id: expectedId,
      name,
      kind: "persistent-production",
      bytes: Buffer.byteLength(content),
      savedAt: "2026-10-11T00:00:00.000Z",
    };
    const existed = archive.has(expectedId);
    archive.set(expectedId, { summary, content });
    if (globalThis.ovenRecipeLoseReply) {
      globalThis.ovenRecipeLoseReply = false;
      await route.abort("failed");
    } else
      await route.fulfill({
        status: existed ? 200 : 201,
        json: { ok: true, snapshot: summary },
      });
  } else if (id !== "") {
    const entry = archive.get(id);
    await route.fulfill(
      entry === undefined
        ? { status: 404, json: { error: "bakery_run_not_found" } }
        : { status: 200, body: entry.content, contentType: "application/json" },
    );
  } else {
    const snapshots = [];
    for (const entry of archive.values()) snapshots.push(entry.summary);
    await route.fulfill({
      status: 200,
      json: { ok: true, snapshots, nextCursor: null },
    });
  }
}

async function installRecipeMutation(page) {
  await page.addScriptTag({
    content: `${saveRecipeCopy.toString()}\nwindow.saveRecipeCopy = saveRecipeCopy;`,
  });
}

async function saveRecipeCopy(path, body) {
  if (path !== "/v1/control/organisations/oven-ui-acceptance/bakery/runs")
    throw new Error("This journey must not mutate commerce.");
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error("The shared run save did not return a receipt.");
  return response.json();
}

async function mountConnectedOvenWorkspace() {
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: WorkflowSimulatorRoute } =
    await import("/src/features/workflow-simulator/route.tsx");
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(WorkflowSimulatorRoute, {
        connection: {
          kind: "workspace",
          organisationId: "oven-ui-acceptance",
          canManage: true,
          mutate: window.saveRecipeCopy,
        },
      }),
    ),
  );
}

async function serveOvenWorkspaceStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}

async function saveOvenDownload(page, name) {
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  const path = `${globalThis.bakeryEvidence}/${name}.json`;
  await (await pending).saveAs(path);
  return path;
}

verifyBakeryShiftBrowser;
