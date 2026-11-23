// The Portal shift author and results on the output of six-hour-shift. This
// harness uses actual Portal components and retained execution evidence. It
// mocks no product result. The row opens the page with
// ?evidence=/@fs/<six-hour-shift>.
async function verifySixHourShiftBrowser(page) {
  const evidenceUrl = new URL(page.url()).searchParams.get("evidence");
  const options = {
    evidenceDirectory: evidenceUrl.replace(/^\/@fs/u, ""),
    screenshotDirectory: globalThis.bakeryEvidence,
  };
  const base = new URL(page.url()).origin;
  const expected = await expectedResults(page, `${base}${evidenceUrl}`);
  await page.route("**/six-hour-acceptance", serveShiftHarness);
  await page.route(
    "**/six-hour-evidence/*",
    serveShiftEvidence.bind(null, options.evidenceDirectory),
  );
  await page.goto(`${base}/six-hour-acceptance`);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(mountShiftAuthor);
  await chooseOption(page, page.getByLabel("Shift scope"), {
    value: "six-hour-shift",
  });
  const defaults = {
    waves: await selectValue(page.getByLabel("Financier production waves")),
    cadence: await selectValue(page.getByLabel("Wave cadence (minutes)")),
    reorderThreshold: await page
      .getByLabel("Financier reorder threshold (units per flavour)")
      .inputValue(),
    grids: await selectValue(page.getByLabel("Cooling rack grids")),
    demand: await selectValue(page.getByLabel("Customer demand pattern")),
    pans: await selectValue(page.getByLabel("Pan availability comparison")),
  };
  if (
    defaults.waves !== "2" ||
    defaults.cadence !== "75" ||
    defaults.reorderThreshold !== "4" ||
    defaults.grids !== "4" ||
    defaults.demand !== "steady" ||
    defaults.pans !== "4"
  ) {
    throw new Error(
      `Portal preset differs from acceptance: ${JSON.stringify(defaults)}`,
    );
  }
  await page
    .getByRole("button", { name: "Prepare bakery shift", exact: true })
    .click();
  await page.waitForFunction(preparedScenario);
  const sixHour = await page.evaluate(preparedScenario);
  if (sixHour.limits.horizon !== 21600e6 || sixHour.availability.length !== 2)
    throw new Error("Six-hour mode lost its horizon or breaks");
  await page.screenshot({
    path: `${options.screenshotDirectory}/preset.png`,
    fullPage: true,
  });

  await page.evaluate(mountShiftAuthor);
  await chooseOption(page, page.getByLabel("Shift scope"), {
    value: "six-hour-shift",
  });
  await chooseOption(page, page.getByLabel("Financier production waves"), {
    value: "1",
  });
  await chooseOption(page, page.getByLabel("Customer demand pattern"), {
    value: "rush",
  });
  await page.evaluate(clearPreparedScenario);
  await page
    .getByRole("button", { name: "Prepare bakery shift", exact: true })
    .click();
  await page.waitForFunction(preparedScenario);
  const oneWave = await page.evaluate(preparedScenario);
  if (oneWave.limits.horizon !== 21600e6 || oneWave.availability.length !== 2)
    throw new Error("Wave count changed shift mode");

  await page.evaluate(mountShiftAuthor);
  await chooseOption(page, page.getByLabel("Shift scope"), {
    value: "six-hour-shift",
  });
  await chooseOption(page, page.getByLabel("Shift scope"), {
    value: "morning-shift",
  });
  if (
    (await page
      .getByLabel("Milk tea batches", { exact: true })
      .inputValue()) !== "2"
  )
    throw new Error("Morning preset retained six-hour tea quantities");
  await page.evaluate(clearPreparedScenario);
  await page
    .getByRole("button", { name: "Prepare bakery shift", exact: true })
    .click();
  await page.waitForFunction(preparedScenario);
  const morning = await page.evaluate(preparedScenario);
  if (morning.limits.horizon !== 28800e6 || morning.availability.length !== 0)
    throw new Error("Morning preset retained six-hour scope");

  await page.evaluate(mountAcceptedShiftResults);
  const evidence = page.getByRole("region", { name: "6-hour shift evidence" });
  await evidence.waitFor();
  const barista = evidence.locator(
    '[data-metric="barista-utilization-percent"]',
  );
  if (
    !(await barista.textContent()).includes(expected.baristaShare) ||
    !(await barista.textContent()).includes("Outside assumed range")
  )
    throw new Error("The Portal hid the observed utilization result");
  if (
    !(await evidence.textContent()).includes("Assumed timings / Uncalibrated")
  )
    throw new Error("The Portal omitted the calibration limit");
  await barista.scrollIntoViewIfNeeded();
  await page.locator(".oven-logistics-scroll").screenshot({
    path: `${options.screenshotDirectory}/accepted-results.png`,
  });

  const fileInput = evidence.getByLabel("Import measured 6-hour shift JSON");
  await fileInput.setInputFiles(
    `${options.evidenceDirectory}/blank-six-hour-template.json`,
  );
  const alert = evidence.getByRole("alert");
  await alert.waitFor();
  if (!(await alert.textContent()).includes("Current results are unchanged."))
    throw new Error("Blank template import did not preserve current results");

  await fileInput.setInputFiles(
    `${options.evidenceDirectory}/synthetic-measured-six-hour-shift.json`,
  );
  const measuredSpan = evidence.locator(
    '[data-measured-metric="shift-span-seconds"]',
  );
  await measuredSpan.waitFor();
  if (
    !(await measuredSpan.textContent()).includes(expected.spanError) ||
    !(await evidence.textContent()).includes(
      "Assumed timings / Uncalibrated (single-shift comparison; separate fitting and validation runs required)",
    )
  ) {
    throw new Error(
      "Measured 6-hour comparison omitted error or calibration limit",
    );
  }
  await measuredSpan.scrollIntoViewIfNeeded();
  await page.locator(".oven-logistics-scroll").screenshot({
    path: `${options.screenshotDirectory}/measured-comparison.png`,
  });

  await page.evaluate(mountMissingShiftResults);
  await page
    .getByText("No accepted execution events", { exact: true })
    .waitFor();
  if ((await page.getByText("100%", { exact: true }).count()) !== 0)
    throw new Error("Missing evidence produced a passing score");
  await page
    .getByText("No accepted execution events", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.locator(".oven-logistics-scroll").screenshot({
    path: `${options.screenshotDirectory}/missing-evidence.png`,
  });
  return {
    result: "passed",
    defaults,
    sixHourHorizon: sixHour.limits.horizon,
    oneWaveHorizon: oneWave.limits.horizon,
    morningHorizon: morning.limits.horizon,
    baristaShare: expected.baristaShare,
    measuredShiftSpanError: expected.spanError,
  };

  // The values that six-hour-shift computed, as the Results panel shows them:
  // a share with two decimals, and a signed error in minutes and seconds.
  async function expectedResults(page, evidence) {
    const read = async (name) =>
      (await page.request.get(`${evidence}/${name}`)).json();
    const report = await read("shift-report.json");
    const comparison = await read("measured-six-hour-comparison.json");
    const barista = findMetric(report, "barista-utilization-percent");
    const span = comparison.metrics.find(
      (metric) => metric.id === "shift-span-seconds",
    ).signedError;
    const total = Math.round(Math.abs(span));
    return {
      baristaShare: barista.measurement.value.toFixed(2),
      spanError: `${span < 0 ? "-" : "+"}${Math.floor(total / 60)} min ${total % 60} s`,
    };
  }

  function findMetric(value, id) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findMetric(item, id);
        if (found !== null) return found;
      }
    } else if (value !== null && typeof value === "object") {
      if (value.id === id && "measurement" in value) return value;
      for (const item of Object.values(value)) {
        const found = findMetric(item, id);
        if (found !== null) return found;
      }
    }
    return null;
  }

  async function serveShiftHarness(route) {
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><title>Six-hour shift acceptance</title></head><body><main id="shift-acceptance" class="production-workspace persistent-production" style="padding:24px"></main></body></html>',
    });
  }

  async function serveShiftEvidence(directory, route) {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (
      !["scenario.json", "view.json", "withheld-evidence-report.json"].includes(
        name,
      )
    )
      throw new Error("Unknown acceptance artifact");
    await route.fulfill({
      contentType: "application/json",
      path: `${directory}/${name}`,
    });
  }

  async function mountShiftAuthor() {
    const { sourceUrl } = await import("/source-url.js");
    const { default: React } = await import("/@id/react");
    const { default: ReactDOM } = await import("/@id/react-dom/client");
    const { BakeryShiftAuthor } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/production-run/bakery-shift-author.tsx",
      )
    );
    await import(sourceUrl("surfaces/portal/ui/styles.css"));
    await import(
      sourceUrl("areas/kitchen/ui/features/production-run/oven-workspace.css")
    );
    if (window.shiftAcceptanceRoot) window.shiftAcceptanceRoot.unmount();
    window.shiftAcceptanceRoot = ReactDOM.createRoot(
      document.getElementById("shift-acceptance"),
    );
    window.shiftAcceptancePrepared = {};
    window.shiftAcceptanceRoot.render(
      React.createElement(BakeryShiftAuthor, {
        prepared: Object.assign.bind(null, window.shiftAcceptancePrepared),
      }),
    );
  }

  function preparedScenario() {
    return window.shiftAcceptancePrepared.scenario;
  }

  function clearPreparedScenario() {
    delete window.shiftAcceptancePrepared.scenario;
  }

  async function mountAcceptedShiftResults() {
    const { sourceUrl } = await import("/source-url.js");
    const base = "/six-hour-evidence";
    const scenario = await (await fetch(`${base}/scenario.json`)).json();
    const view = await (await fetch(`${base}/view.json`)).json();
    const { default: React } = await import("/@id/react");
    const { ProductionResults } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/production-run/production-results.tsx",
      )
    );
    const { reportBakeryShift } =
      await import("/@id/@purin-labs/production-simulation/recipes/bakery/shift-report");
    const shift = reportBakeryShift(
      scenario,
      view.logistics,
      view.resourceHistory,
      view.production,
      view.time,
      "complete",
    );
    window.shiftAcceptanceRoot.render(
      React.createElement(ProductionResults, {
        time: view.time,
        results: view.production,
        shift,
      }),
    );
  }

  async function mountMissingShiftResults() {
    const { sourceUrl } = await import("/source-url.js");
    const base = "/six-hour-evidence";
    const shift = await (
      await fetch(`${base}/withheld-evidence-report.json`)
    ).json();
    const { default: React } = await import("/@id/react");
    const { ProductionResults } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/production-run/production-results.tsx",
      )
    );
    window.shiftAcceptanceRoot.render(
      React.createElement(ProductionResults, {
        time: 0,
        results: { orders: [], ordersCompleted: 0, reported: [], stock: [] },
        shift,
      }),
    );
  }
}
