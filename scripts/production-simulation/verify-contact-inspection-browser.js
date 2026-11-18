async function verifyContactInspectionBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", contactStyles);
  await openPhysicsEvidence(page);
  const source =
    "/@fs/Users/pta/Dev/lowerarchy/satyr/services/platform/tests/fixtures/bakery-persistent-failure.json";
  const reference = await page.evaluate(readContactReference, source);
  await page.evaluate(mountContactWorkspace);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  const file = await page.request.get(new URL(source, page.url()).href);
  await page
    .getByLabel("Open recipe, oven route or saved production run", {
      exact: true,
    })
    .setInputFiles({
      name: "failed-native-factory.json",
      mimeType: "application/json",
      buffer: await file.body(),
    });
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page.locator('[data-graph-task="tray-orders#0/transfer"]').waitFor();
  await page.locator('[data-graph-task="tray-orders#0/transfer"]').click();
  await page
    .getByRole("button", { name: "Inspect selected physics", exact: true })
    .click();
  const inspection = page.getByRole("region", {
    name: "Accepted physics inspection",
    exact: true,
  });
  await inspection.waitFor();
  await inspection
    .locator('input[aria-label="Recorded physics sample"]')
    .fill(String(reference.index));
  await inspection.getByText("Recorded contacts", { exact: true }).click();
  await inspection
    .locator(
      `[aria-label="Exact contact evidence"][data-step="${reference.step}"][data-coverage="recorded"]`,
    )
    .waitFor();
  const rows = await inspection
    .locator("[data-contact-first]")
    .evaluateAll(contactRows);
  if (JSON.stringify(rows) !== JSON.stringify(reference.pairs))
    throw new Error("Rendered contacts differ from the saved solver evidence.");
  await inspection
    .getByLabel("Outline recorded contact shapes", { exact: true })
    .check();
  await page.waitForFunction(contactOutlinesVisible);
  await inspection.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "exact-contact-shapes.png", fullPage: true });
  await inspection
    .locator('input[aria-label="Recorded physics sample"]')
    .fill("0");
  await inspection
    .locator(
      '[aria-label="Exact contact evidence"][data-coverage="unavailable"]',
    )
    .waitFor();
  if (
    (await inspection
      .locator(".oven-physics-scene")
      .getAttribute("data-contact-shapes")) !== "0"
  )
    throw new Error("Contact outlines leaked into a step with no evidence.");
  const observed = await page
    .getByLabel("Simulation seconds", { exact: true })
    .textContent();
  const saved = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  await (
    await saved
  ).saveAs(`${globalThis.bakeryEvidence}/inspected-failed-world.json`);
  return {
    result: "passed",
    step: reference.step,
    pairs: rows,
    exactSampleIndex: reference.index,
    simulationSeconds: observed,
    noContactClaimAtInitialStep: true,
    overlaysCleared: true,
    source,
  };
}
async function contactStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}
async function mountContactWorkspace() {
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
async function readContactReference(source) {
  const saved = await (await fetch(source)).json();
  const { readRecordingPack } =
    await import("/@id/@seams/production-simulation");
  const { nativeIdentity } =
    await import("/@id/@seams/production-simulation/native/cell-adapter");
  let attempt = null;
  for (const task of saved.document.state.tasks)
    if (task.id === "tray-orders#0/transfer")
      attempt = nativeIdentity(task.attempt);
  let peak = null;
  for (const artifact of saved.artifacts) {
    if (!artifact.content.startsWith('{"kind":"recording-pack"')) continue;
    const pack = readRecordingPack(artifact.content);
    if (!pack.ok) throw new Error("Invalid fixture recording pack.");
    for (const entry of pack.value.records) {
      const record = JSON.parse(
        pack.value.body.slice(entry.offset, entry.offset + entry.byteLength),
      );
      if (record.attemptId !== attempt || record.contacts?.kind !== "dense")
        continue;
      for (const observation of record.contacts.observations) {
        let force = 0;
        for (const pair of observation.pairs) force += pair.normalForceN;
        if (peak === null || force > peak.force)
          peak = { force, step: observation.step, pairs: observation.pairs };
      }
    }
  }
  if (peak === null || peak.force <= 0)
    throw new Error("Fixture has no recorded contact force.");
  const pairs = [];
  for (const pair of peak.pairs)
    pairs.push({
      first: pair.first.geometry,
      second: pair.second.geometry,
      force: pair.normalForceN,
      penetration: pair.penetrationM,
    });
  return { index: peak.step, step: peak.step, pairs };
}
function contactRows(rows) {
  const values = [];
  for (const row of rows)
    values.push({
      first: row.dataset.contactFirst,
      second: row.dataset.contactSecond,
      force: Number(row.querySelector("[data-force-n]").dataset.forceN),
      penetration: Number(
        row.querySelector("[data-penetration-m]").dataset.penetrationM,
      ),
    });
  return values;
}
function contactOutlinesVisible() {
  return (
    Number(
      document.querySelector(
        '[aria-label="Accepted physics inspection"] .oven-physics-scene',
      )?.dataset.contactShapes,
    ) > 0
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
