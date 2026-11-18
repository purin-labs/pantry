async function verifyFactoryOverviewBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", factoryStyles);
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addScriptTag({
    content: [
      renderFactoryEvidence,
      selectFactoryTask,
      keepFactoryResult,
      clearFactoryResults,
    ]
      .map(factoryFunctionText)
      .join("\n"),
  });
  await page.evaluate(openFactoryEvidence);
  await page.evaluate(loadFactoryActive);
  const overview = page.getByRole("region", {
    name: "Factory overview",
    exact: true,
  });
  await overview.waitFor();
  const positions = await overview.locator("[data-factory-position]").count();
  const transfers = await overview.locator("[data-factory-transfer]").count();
  if (positions !== 7 || transfers !== 7)
    throw new Error("The complete tray loop is missing.");
  await page.evaluate(checkFactoryCustody);
  const task = await overview.getByRole("button").first().textContent();
  await overview.getByRole("button").first().click();
  await page
    .locator(`[data-timeline-task="${task}"] button[aria-pressed="true"]`)
    .first()
    .waitFor();
  await page.evaluate(checkFactoryUnchanged);
  if (
    !(await page
      .getByRole("button", { name: "Keep completed result", exact: true })
      .isDisabled())
  )
    throw new Error("An unfinished run entered comparisons.");
  await page.screenshot({ path: "factory-active.png", fullPage: true });
  const cases = [
    "balanced-baseline",
    "balanced-hold",
    "balanced-buffer",
    "balanced-hold-buffer",
    "stress-one-slot",
    "stress-two-slots",
  ];
  for (const name of cases) {
    await page.evaluate(loadFactoryCompleted, name);
    await page
      .getByRole("button", { name: "Keep completed result", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "Keep completed result", exact: true })
    .click();
  const comparison = page.getByRole("region", {
    name: "Factory comparisons",
    exact: true,
  });
  if ((await comparison.getByRole("table").count()) !== 2)
    throw new Error("Balanced and overloaded cases must form separate groups.");
  if ((await comparison.locator("[data-comparison-result]").count()) !== 6)
    throw new Error("A repeated capture duplicated a result.");
  const metrics = await page.evaluate(checkFactoryComparisons);
  await comparison.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "factory-comparisons.png", fullPage: true });
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export comparison results", exact: true })
    .click();
  await (
    await download
  ).saveAs(`${globalThis.bakeryEvidence}/factory-comparisons.json`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(loadFactoryActive);
  await overview.scrollIntoViewIfNeeded();
  const overflow = await overview.evaluate(factoryOverflow);
  if (overflow > 1)
    throw new Error(`Factory overview overflows by ${overflow} pixels.`);
  await page.screenshot({ path: "factory-mobile.png", fullPage: true });
  await page
    .getByRole("button", { name: "Clear comparison results", exact: true })
    .click();
  if ((await comparison.locator("[data-comparison-result]").count()) !== 0)
    throw new Error("Clear did not remove comparisons.");
  return {
    result: "passed",
    positions,
    transfers,
    selectedTask: task,
    groups: 2,
    cases: metrics,
    narrowViewportOverflow: overflow,
    evidence:
      "Six accepted retained-engine campaign saves; active selection preserves committed state. This journey checks presentation and export without rerunning physics.",
  };
}
function factoryFunctionText(fn) {
  return fn.toString();
}
async function factoryStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}
async function openFactoryEvidence() {
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const overview =
    await import("/src/features/production-run/factory-overview.tsx");
  const comparison =
    await import("/src/features/production-run/factory-comparison.tsx");
  const tasks =
    await import("/src/features/production-run/oven-task-views.tsx");
  const standard = await import("/@id/@seams/std");
  await import("/src/features/production-run/oven-workspace.css");
  const directory =
    "/@fs/Users/pta/Dev/lowerarchy/satyr/output/acceptance/plan-70/j2-recurring-campaign-2026-10-11-r2";
  const expected = await (await fetch(`${directory}/comparisons.json`)).json();
  const engine = await import(
    `${directory}/executions/${expected.bundle}/production-engine.mjs`
  );
  window.factoryEvidence = {
    React,
    overview,
    comparison,
    tasks,
    standard,
    directory,
    expected,
    engine,
    root: ReactDOM.createRoot(document.getElementById("root")),
    selected: null,
    results: [],
    current: null,
    scenario: null,
    view: null,
    original: null,
  };
}
async function loadFactoryActive() {
  const e = window.factoryEvidence;
  const document = await (
    await fetch(`${e.directory}/stress-one-slot/interrupted/save-1.json`)
  ).json();
  const opened = await e.engine.openResumable(document, "browser", [
    document.bundle,
  ]);
  if (!opened.ok)
    throw new Error("Active evidence failed its retained parser.");
  e.scenario = opened.value.state.definition.scenario;
  e.view = e.engine.executionView(opened.value.state);
  e.original = e.standard.canonicalJson(e.view);
  e.current = e.comparison.factoryResult(
    e.scenario,
    document.bundle.id,
    e.view,
  );
  e.selected = null;
  renderFactoryEvidence();
}
async function loadFactoryCompleted(name) {
  const e = window.factoryEvidence;
  const document = await (
    await fetch(`${e.directory}/${name}/reference/save-1.json`)
  ).json();
  const opened = await e.engine.openResumable(document, "browser", [
    document.bundle,
  ]);
  if (!opened.ok) throw new Error(`Invalid accepted save: ${name}`);
  e.scenario = opened.value.state.definition.scenario;
  e.view = e.engine.executionView(opened.value.state);
  e.current = e.comparison.factoryResult(
    e.scenario,
    document.bundle.id,
    e.view,
  );
  if (e.current === null)
    throw new Error(`Completed case missing results: ${name}`);
  e.selected = null;
  renderFactoryEvidence();
}
function renderFactoryEvidence() {
  const e = window.factoryEvidence;
  e.root.render(
    e.React.createElement(
      "div",
      {
        className: "production-panel",
        style: {
          width: "100%",
          maxWidth: "none",
          height: "100vh",
          overflow: "auto",
        },
      },
      e.React.createElement(e.overview.FactoryOverview, {
        scenario: e.scenario,
        view: e.view,
        selected: e.selected,
        select: selectFactoryTask,
      }),
      e.React.createElement(e.comparison.FactoryComparison, {
        results: e.results,
        current: e.current,
        capture: keepFactoryResult,
        clear: clearFactoryResults,
      }),
      e.React.createElement(e.tasks.OvenTaskViews, {
        view: e.view.logistics,
        time: e.view.time,
        horizon: e.view.horizon,
        selected: e.selected,
        select: selectFactoryTask,
      }),
    ),
  );
}
function selectFactoryTask(task) {
  window.factoryEvidence.selected = task;
  renderFactoryEvidence();
}
function keepFactoryResult(result) {
  const e = window.factoryEvidence;
  const results = [];
  for (const previous of e.results)
    if (previous.identity !== result.identity) results.push(previous);
  results.push(result);
  e.results = results;
  renderFactoryEvidence();
}
function clearFactoryResults() {
  window.factoryEvidence.results = [];
  renderFactoryEvidence();
}
function checkFactoryUnchanged() {
  const e = window.factoryEvidence;
  if (e.original !== e.standard.canonicalJson(e.view))
    throw new Error("Selection changed the committed view.");
}
function checkFactoryCustody() {
  const e = window.factoryEvidence;
  for (const store of e.view.logistics.carrierStores) {
    const text = document.querySelector(
      `[data-factory-position="${store.id}"]`,
    ).textContent;
    for (const carrier of store.occupants)
      if (!text.includes(carrier))
        throw new Error(`Missing occupant ${carrier}`);
    for (const reservation of store.reservations)
      if (
        !text.includes(reservation.carrier) ||
        !text.includes(reservation.task)
      )
        throw new Error("Missing reserved arrival.");
  }
}
function checkFactoryComparisons() {
  const e = window.factoryEvidence;
  const metrics = [];
  for (const [index, expected] of e.expected.cases.entries()) {
    const actual = e.results[index];
    const fields = {
      endSeconds: "endSeconds",
      fullBufferSeconds: "fullBufferSeconds",
      bakerOccupiedSeconds: "bakerOccupiedSeconds",
      output: "completed",
      sourceBlockedSeconds: "sourceBlockedByBufferSeconds",
      carrierWaitSeconds: "waitingForCarrierSeconds",
    };
    for (const [field, source] of Object.entries(fields))
      if (actual[field] !== expected[source])
        throw new Error(
          `${expected.name}: ${field} differs from accepted campaign evidence.`,
        );
    metrics.push({
      name: expected.name,
      output: actual.output,
      endSeconds: actual.endSeconds,
      bufferFullSeconds: actual.fullBufferSeconds,
      sourceBlockedSeconds: actual.sourceBlockedSeconds,
      carrierWaitSeconds: actual.carrierWaitSeconds,
      bakerOccupiedSeconds: actual.bakerOccupiedSeconds,
    });
  }
  return metrics;
}
function factoryOverflow(element) {
  return element.scrollWidth - element.clientWidth;
}
