// Run with Playwright CLI's run-code command against the Portal dev server.
// The native acceptance journey must finish first. This harness uses actual
// Portal components and retained execution evidence. It mocks no product result.
async function verifySixHourShiftBrowser(
  page,
  options = {
    evidenceDirectory:
      "output/acceptance/plan-61E/six-hour-measured-intake-20261102",
    screenshotDirectory: "output/playwright/six-hour-measured-intake-20261102",
  },
) {
  await page.route("**/six-hour-acceptance", serveShiftHarness);
  await page.route(
    "**/six-hour-evidence/*",
    serveShiftEvidence.bind(null, options.evidenceDirectory),
  );
  await page.goto("http://127.0.0.1:3103/six-hour-acceptance");
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
    !(await barista.textContent()).includes("17.17") ||
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
    !(await measuredSpan.textContent()).includes("-2 min 24 s") ||
    !(await evidence.textContent()).includes(
      "Assumed timings / Uncalibrated (single-shift comparison; separate fitting and validation runs required)",
    )
  ) {
    throw new Error("Measured 6-hour comparison omitted error or calibration limit");
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
    measuredShiftSpanError: "-2 min 24 s",
  };

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
    const { default: React } = await import("/@id/react");
    const { default: ReactDOM } = await import("/@id/react-dom/client");
    const { BakeryShiftAuthor } =
      await import("/src/features/production-run/bakery-shift-author.tsx");
    await import("/src/styles.css");
    await import("/src/features/production-run/oven-workspace.css");
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
    const base = "/six-hour-evidence";
    const scenario = await (await fetch(`${base}/scenario.json`)).json();
    const view = await (await fetch(`${base}/view.json`)).json();
    const { default: React } = await import("/@id/react");
    const { ProductionResults } =
      await import("/src/features/production-run/production-results.tsx");
    const { reportBakeryShift } =
      await import("/@id/@seams/production-simulation/recipes/bakery/shift-report");
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
    const base = "/six-hour-evidence";
    const shift = await (
      await fetch(`${base}/withheld-evidence-report.json`)
    ).json();
    const { default: React } = await import("/@id/react");
    const { ProductionResults } =
      await import("/src/features/production-run/production-results.tsx");
    window.shiftAcceptanceRoot.render(
      React.createElement(ProductionResults, {
        time: 0,
        results: { orders: [], ordersCompleted: 0, reported: [], stock: [] },
        shift,
      }),
    );
  }

  // The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
    if ("values" in choice) {
      const wanted = choice.values.map(String);
      for (const item of await items.all()) {
        const chosen = wanted.includes(await item.getAttribute("data-value"));
        const selected = (await item.getAttribute("aria-selected")) === "true";
        if (chosen !== selected) await item.click();
      }
      await page.keyboard.press("Escape");
    } else if ("value" in choice) {
      await popup
        .locator(
          `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
        )
        .click();
    } else if ("label" in choice) {
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }

  // The form value of a Portal Select. Base UI keeps it in a hidden input that
  // it renders after the Select's parts.
  function selectValue(trigger) {
    return trigger.evaluate(function hiddenSelectValue(button) {
      for (let node = button; node !== null; node = node.parentElement) {
        for (
          let next = node.nextElementSibling;
          next !== null;
          next = next.nextElementSibling
        ) {
          if (
            next instanceof HTMLInputElement &&
            next.getAttribute("aria-hidden") === "true"
          )
            return next.value;
        }
      }
      throw new Error("A Portal Select has no hidden input.");
    });
  }
}
