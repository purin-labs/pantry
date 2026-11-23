// The pour-over brew in the production workspace: prepare, start, pause in
// the second pour, save to the workspace, reload, reopen and continue to the
// measured beverage. A second brew loses the kettle grip and shows the failure.
async function verifyPourOverBrowser(page) {
  globalThis.pourOverArchive = new Map();
  await page.route(
    "**/v1/control/organisations/pour-over-acceptance/bakery/runs**",
    pourOverArchiveRequest,
  );
  await page.route("**/src/dev/workflow-preview.tsx", servePourOverStyles);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  await openWorkflowCard(page, /^Pour-over station/);
  const author = page.getByRole("form", {
    name: "Pour-over recipe",
    exact: true,
  });
  await author.getByLabel("Kettle water (g)").fill("500");
  await author.screenshot({ path: "pour-over-author.png" });
  await author
    .getByRole("button", { name: "Prepare pour-over", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  const station = page.getByRole("region", {
    name: "Accepted pour-over station state",
    exact: true,
  });
  await station
    .locator('[data-pour-over-phase="pour-2"]')
    .or(page.locator('[data-pour-over-phase="pour-2"]'))
    .first()
    .waitFor({ timeout: 240000 });
  await page
    .locator("[data-pour-over-stage]")
    .filter({ hasText: "Pour 2 of 4 · spiral pour" })
    .waitFor({ timeout: 60000 });
  await page.screenshot({ path: "pour-over-pour-2.png" });
  await page
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "paused" })
    .waitFor();
  const paused = await stationValues(page);
  if (paused.phase !== "pour-2")
    throw new Error(`The pause left pour 2: ${paused.phase}`);
  await page.screenshot({ path: "pour-over-paused.png" });
  await saveShared(page, "Pour-over in pour 2");
  const sourceId = [...globalThis.pourOverArchive.keys()][0];
  const source = globalThis.pourOverArchive.get(sourceId).content;

  await reopenShared(page, "Pour-over in pour 2");
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page
    .locator('[data-pour-over-phase="pour-2"]')
    .first()
    .waitFor({ timeout: 120000 });
  const reopened = await stationValues(page);
  const reopenedStatus = await page
    .getByLabel("Execution status", { exact: true })
    .textContent();
  await page.screenshot({ path: "pour-over-reopened.png" });
  // Continue resumes execution at once, so the first reopened frame follows
  // the pause. The engine journey compares the restored checkpoint exactly.
  if (
    reopened.step < paused.step ||
    Number(reopened.beverageG) < Number(paused.beverageG) ||
    reopenedStatus === "blocked"
  )
    throw new Error(
      `The reopened brew did not continue from the saved pause: ${JSON.stringify({ paused, reopened, reopenedStatus })}`,
    );
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 600000 });
  await page
    .locator("[data-pour-over-stage]")
    .filter({ hasText: "Brew complete" })
    .waitFor({ timeout: 60000 });
  const completed = await stationValues(page);
  await page.screenshot({ path: "pour-over-completed.png" });
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await page
    .getByRole("region", { name: "Production results", exact: true })
    .screenshot({ path: "pour-over-results.png" });
  await saveShared(page, "Pour-over completed");
  if (globalThis.pourOverArchive.size !== 2)
    throw new Error("The brew did not keep two immutable shared snapshots.");
  if (globalThis.pourOverArchive.get(sourceId).content !== source)
    throw new Error("Continuation changed the saved pause.");
  const file = await saveDownload(page, "pour-over-completed");
  const checked = await page.evaluate(checkBrew, file);

  await openWorkspace(page);
  await openWorkflowCard(page, /^Pour-over station/);
  await chooseOption(page, author.getByLabel("Process check"), {
    label: "Lose the kettle grip in pour 2",
  });
  await author
    .getByRole("button", { name: "Prepare pour-over", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page
    .locator('[data-pour-over-failure="lost-grasp"]')
    .waitFor({ timeout: 240000 });
  const failed = await stationValues(page);
  await page.screenshot({ path: "pour-over-grip-failure.png" });
  const status = await page
    .getByLabel("Execution status", { exact: true })
    .textContent();
  if (!status?.includes("blocked"))
    throw new Error(`A failed brew must hold its work: ${status}`);
  return {
    result: "passed",
    paused,
    reopened,
    reopenedStatus,
    completed,
    failed,
    ...checked,
    sharedPauseAndCompletion: true,
    savedPauseUnchanged: true,
  };
}

async function openWorkspace(page) {
  await page.reload();
  await page.addScriptTag({
    content: `${savePourOverCopy.toString()}\nwindow.savePourOverCopy = savePourOverCopy;`,
  });
  await page.evaluate(mountConnectedWorkspace);
}

async function stationValues(page) {
  const station = page.locator(".pour-over-station").first();
  await station.waitFor();
  const read = async (selector, attribute) =>
    station.locator(selector).first().getAttribute(attribute);
  return {
    phase: await station.getAttribute("data-pour-over-phase"),
    step: Number(await station.getAttribute("data-pour-over-step")),
    stage: await station.locator("[data-pour-over-stage]").textContent(),
    scale: await read("[data-pour-over-scale]", "data-pour-over-scale"),
    kettleG: await read("[data-pour-over-kettle]", "data-pour-over-kettle"),
    beverageG: await read(
      "[data-pour-over-beverage]",
      "data-pour-over-beverage",
    ),
  };
}

async function saveShared(page, name) {
  const shared = page.getByRole("region", {
    name: "Workspace saved runs",
    exact: true,
  });
  if (!(await shared.isVisible()))
    await page.getByRole("button", { name: "Save", exact: true }).click();
  await shared.getByLabel("Run name (required)").fill(name);
  await shared
    .getByRole("button", { name: "Review save", exact: true })
    .click();
  await shared
    .getByRole("button", { name: "Confirm save", exact: true })
    .click();
  await shared
    .getByRole("status")
    .filter({ hasText: "verified" })
    .waitFor({ timeout: 120000 });
  await shared.screenshot({
    path: `pour-over-shared-${name.toLowerCase().replaceAll(" ", "-")}.png`,
  });
}

async function reopenShared(page, name) {
  await openWorkspace(page);
  await openWorkflowCard(page, /^Shared production runs/);
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  if (
    await page
      .getByRole("button", { name: "Continue saved run", exact: true })
      .isDisabled()
  )
    throw new Error("Shared open must await explicit continuation.");
}

async function saveDownload(page, name) {
  const download = page.getByRole("button", {
    name: "Download save file",
    exact: true,
  });
  if (!(await download.isVisible()))
    await page.getByRole("button", { name: "Save", exact: true }).click();
  const pending = page.waitForEvent("download");
  await download.click();
  const path = `${globalThis.bakeryEvidence}/${name}.json`;
  await (await pending).saveAs(path);
  return path;
}

async function checkBrew(path) {
  const response = await fetch(`/@fs/${path}`);
  const saved = await response.json();
  const state = saved.document.state;
  if (
    state.definition.scenario.id !== "pour-over-service" ||
    state.status.kind !== "completed"
  )
    throw new Error("The wrong brew finished.");
  const produced = state.events.filter(
    (event) => event.kind === "lot-produced",
  );
  const beverage = produced.filter(
    (event) => event.product === "brewed-coffee",
  );
  if (beverage.length !== 1)
    throw new Error("The brew must produce one beverage lot.");
  let measured = 0;
  for (const event of produced) measured += event.quantity.amount;
  for (const event of state.events)
    if (event.kind === "quantity-reported" && event.role === "loss")
      measured += event.quantity.amount;
  if (measured !== 527000)
    throw new Error(`Measured material ${measured} mg does not balance.`);
  for (const event of state.events)
    if (event.kind === "quantity-reported" && event.role === "final-output")
      throw new Error("The beverage stays in the server until service.");
  return {
    beverageMg: beverage[0].quantity.amount,
    measuredMg: measured,
    executionBundle: saved.document.bundle.id,
    finalCheckpoints: state.cells.map(
      (cell) => cell.committed.checkpoint.digest,
    ),
    artifacts: saved.document.artifacts.length,
  };
}

// The fake answers the workspace run store's staged protocol: prepare the
// exact candidate, upload each missing artifact, publish, then read back.
async function pourOverArchiveRequest(route) {
  const request = route.request();
  const url = new URL(request.url());
  const prefix = "/v1/control/organisations/pour-over-acceptance/bakery/runs";
  const parts = url.pathname.slice(prefix.length + 1).split("/");
  const archive = globalThis.pourOverArchive;
  const staged = (globalThis.pourOverStaged ??= new Map());
  const reply = (status, json) => route.fulfill({ status, json });
  if (request.method() === "POST" && parts[0] === "prepared") {
    const id = parts[1];
    const entry = staged.get(id) ?? { artifacts: new Map() };
    if (parts.length === 2) {
      const { expectedId, name, document } = request.postDataJSON();
      const content = JSON.stringify({ name, document });
      if (expectedId !== id || (await sha256(content)) !== id)
        return reply(409, { error: "bakery_run_payload_mismatch" });
      entry.content = content;
      entry.index = new Map(
        document.document.artifacts.map((artifact) => [
          artifact.digest,
          artifact.byteLength,
        ]),
      );
      staged.set(id, entry);
      const missing = [...entry.index.keys()].filter(
        (digest) => !entry.artifacts.has(digest),
      );
      return reply(200, { ok: true, id, missing });
    }
    const digest = parts[3];
    const { content } = request.postDataJSON();
    const byteLength = Buffer.byteLength(content);
    if (
      entry.index?.get(digest) !== byteLength ||
      (await sha256(content)) !== digest
    )
      return reply(409, { error: "bakery_run_artifact_mismatch" });
    entry.artifacts.set(digest, content);
    return reply(200, { ok: true, digest, byteLength });
  }
  if (request.method() === "POST") {
    const { expectedId, name, document } = request.postDataJSON();
    const content = JSON.stringify({ name, document });
    const entry = staged.get(expectedId);
    if (
      entry?.content !== content ||
      [...entry.index.keys()].some((digest) => !entry.artifacts.has(digest))
    )
      return reply(409, { error: "bakery_run_artifacts_incomplete" });
    const summary = {
      id: expectedId,
      name,
      kind: "persistent-production",
      bytes: Buffer.byteLength(content),
      savedAt: "2026-10-19T00:00:00.000Z",
    };
    const existed = archive.has(expectedId);
    archive.set(expectedId, { summary, content, artifacts: entry.artifacts });
    return reply(existed ? 200 : 201, { ok: true, snapshot: summary });
  }
  const entry = archive.get(parts[0]);
  if (parts[0] === "") {
    const snapshots = [];
    for (const saved of archive.values()) snapshots.push(saved.summary);
    return reply(200, { ok: true, snapshots, nextCursor: null });
  }
  if (entry === undefined) return reply(404, { error: "bakery_run_not_found" });
  if (parts.length === 1)
    return route.fulfill({
      status: 200,
      body: entry.content,
      contentType: "application/json",
    });
  const content = entry.artifacts.get(parts[2]);
  return content === undefined
    ? reply(404, { error: "bakery_run_artifact_not_found" })
    : reply(200, { digest: parts[2], content });
}

async function sha256(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Buffer.from(digest).toString("hex");
}

async function savePourOverCopy(path, body) {
  if (
    !path.startsWith(
      "/v1/control/organisations/pour-over-acceptance/bakery/runs",
    )
  )
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

async function mountConnectedWorkspace() {
  const { sourceUrl } = await import("/source-url.js");
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: WorkflowSimulatorRoute } = await import(
    sourceUrl("areas/kitchen/ui/features/workflow-simulator/route.tsx")
  );
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(WorkflowSimulatorRoute, {
        connection: {
          kind: "workspace",
          organisationId: "pour-over-acceptance",
          canManage: true,
          mutate: window.savePourOverCopy,
        },
      }),
    ),
  );
}

async function servePourOverStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: `import "${checkoutUrl("apps/portal/src/styles.css")}";`,
  });
}

verifyPourOverBrowser;
