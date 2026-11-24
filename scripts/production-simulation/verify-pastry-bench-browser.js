// Pie Pastry Bench MuJoCo 4.0.0 deformable `flexcomp` (`elastic2d="both"`) WebGL journey:
// open recipe author, run shortcrust sheeting + checkpoint continuation into puff-lid
// draping in the browser Wasm worker, inspect 81-vertex / 128-triangle deformable shell
// across camera presets, verify results telemetry, then inject the unfloured-bench fault
// and verify rejection + 14 g T55 flour recovery.
async function verifyPastryBenchBrowser(page) {
  await page.route("**/src/dev/workflow-preview.tsx", previewStyles);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);

  await openPastryBenchRecipeForm(page);
  const author = page.getByRole("form", {
    name: "Pie pastry bench deformable recipe",
    exact: true,
  });
  await author.screenshot({ path: "pastry-bench-author.png" });
  await author
    .getByRole("button", { name: "Prepare pastry bench", exact: true })
    .click();

  const station = page.getByRole("region", {
    name: "Accepted pastry bench deformable state",
    exact: true,
  });
  await station.waitFor({ state: "visible", timeout: 30000 });
  await page
    .locator(
      '[data-pastry-vertices="81"][data-pastry-triangles="128"][data-pastry-dough-vertices="75"][data-pastry-dough-triangles="128"]',
    )
    .waitFor({ timeout: 120000 });

  await station
    .getByRole("button", { name: "3D dough block", exact: true })
    .click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: "pastry-bench-dough-block.png" });

  await station
    .getByRole("button", { name: "12 cm tin cavity", exact: true })
    .click();
  await page.screenshot({ path: "pastry-bench-tin-cavity.png" });

  await station
    .getByRole("button", { name: "Overhead sheet", exact: true })
    .click();
  await page.screenshot({ path: "pastry-bench-overhead.png" });

  await station
    .getByRole("button", { name: "Bench view", exact: true })
    .click();

  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 120000 });

  await station
    .getByRole("button", { name: "3D dough block", exact: true })
    .click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: "pastry-bench-dough-block-pressed.png" });

  await station
    .getByRole("button", { name: "Maruzen oven", exact: true })
    .click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: "pastry-bench-oven-bake.png" });

  const nominalStation = await readStationState(station);
  if (
    nominalStation.phase !== "oven-bake" ||
    nominalStation.vertices !== 81 ||
    nominalStation.triangles !== 128 ||
    nominalStation.doughVertices !== 75 ||
    nominalStation.doughTriangles !== 128 ||
    nominalStation.doughHeightMm > 24.5 ||
    nominalStation.doughHeightMm < 15.0 ||
    nominalStation.doughSpanMm < 78.0 ||
    nominalStation.drapeMm < 15 ||
    nominalStation.sealPct < 99 ||
    nominalStation.ovenC < 195 ||
    nominalStation.browningPct < 88 ||
    nominalStation.puffLiftMm < 4.5
  ) {
    throw new Error(
      `Unexpected nominal pastry bench + Maruzen oven state: ${JSON.stringify(nominalStation)}`,
    );
  }

  await page.getByRole("button", { name: "Results", exact: true }).click();
  const details = page.getByRole("complementary", {
    name: "Factory details",
    exact: true,
  });
  await details.waitFor({ state: "visible", timeout: 15000 });
  const nominalResultsText = (await details.textContent()) ?? "";
  if (
    !nominalResultsText.includes("75 vertices · 128 boundary triangles") ||
    !nominalResultsText.includes("81 vertices · 128 triangles") ||
    !nominalResultsText.includes("100.0%") ||
    !nominalResultsText.includes("Maruzen MBCO-5E convection bake")
  ) {
    throw new Error(
      `Missing 3D/2D flexcomp topology, crimp seal, or Maruzen oven bake in results: ${nominalResultsText}`,
    );
  }
  await page.screenshot({ path: "pastry-bench-nominal-results.png" });

  // Switch to Scenario drawer and run the unfloured bench fault + flour recovery check
  await page.getByRole("button", { name: "Scenario", exact: true }).click();
  await chooseOption(page, details.getByLabel("Savoury pie variety"), {
    value: "beef-bourguignon",
  });
  await chooseOption(page, details.getByLabel("Shortcrust target thickness"), {
    value: "3.5",
  });
  await chooseOption(page, details.getByLabel("Puff-pastry rim crimp force"), {
    value: "52",
  });
  await chooseOption(page, details.getByLabel("Process check"), {
    value: "unfloured-bench",
  });
  await details
    .getByRole("button", { name: "Run MuJoCo 4.0.0 flexcomp", exact: true })
    .click();

  await page
    .locator('[data-pastry-fault="pastry-bench-unfloured"]')
    .waitFor({ state: "visible", timeout: 120000 });
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "completed" })
    .waitFor({ timeout: 120000 });
  await page.screenshot({ path: "pastry-bench-unfloured-recovery.png" });

  await page.getByRole("button", { name: "Results", exact: true }).click();
  const faultResultsText = (await details.textContent()) ?? "";
  if (
    !faultResultsText.includes("Unfloured attempt drape") ||
    !faultResultsText.includes("rejected by 14 mm gate") ||
    !faultResultsText.includes("Recovered floured drape")
  ) {
    throw new Error(
      `Missing unfloured fault rejection & recovery evidence: ${faultResultsText}`,
    );
  }
  const recoveredStation = await readStationState(station);
  const factoryStationsCheck = await page.evaluate(verifyPieFactoryStations);

  return {
    result: "passed",
    hasWebGL: true,
    nominalStation,
    recoveredStation,
    factoryStationsCheck,
    faultBannerText: await page
      .locator('[data-pastry-fault="pastry-bench-unfloured"]')
      .textContent(),
  };
}

async function verifyPieFactoryStations() {
  const { sourceUrl } = await import("/source-url.js");
  const [
    { compilePieRecipe, pieRecipeInput },
    { PIE_STATIONS, factoryStationsForScenario, isPieScenario },
    { MORNING_SHIFT_STATIONS, synchronizeMorningShiftAppliances },
    { FactoryStations },
  ] = await Promise.all([
    import("/@id/@purin-labs/production-simulation/recipes/bakery/pie"),
    import(
      sourceUrl("areas/kitchen/ui/features/production-run/factory-places.ts")
    ),
    import(
      sourceUrl(
        "areas/kitchen/ui/features/production-run/morning-shift-appliances.ts",
      )
    ),
    import(
      sourceUrl(
        "areas/kitchen/ui/features/workflow-simulator/spatial/factory-stations.ts",
      )
    ),
  ]);

  const compiled = await compilePieRecipe(
    pieRecipeInput({
      pies: ["steak-and-pepper"],
      piesPerType: 3,
      stage: "assembly",
    }),
  );
  if (!compiled.ok) {
    throw new Error(`Pie recipe compilation failed: ${compiled.error.code}`);
  }
  const scenario = compiled.value;
  if (!isPieScenario(scenario)) {
    throw new Error("Expected isPieScenario(scenario) to be true");
  }
  const resolvedStations = factoryStationsForScenario(scenario);
  if (resolvedStations !== PIE_STATIONS) {
    throw new Error(
      "Expected factoryStationsForScenario to return PIE_STATIONS",
    );
  }
  const morningOven = MORNING_SHIFT_STATIONS.find(
    (s) => s.id === "station-oven",
  );
  if (!morningOven || !morningOven.stores.includes("oven-pie-trays")) {
    throw new Error(
      "Expected MORNING_SHIFT_STATIONS station-oven to include oven-pie-trays",
    );
  }

  const factory = new FactoryStations(PIE_STATIONS);
  await factory.load(new AbortController().signal);

  const makeBakeLogistics = (timeUs) => ({
    kind: "available",
    tasks: [
      {
        id: "steak-and-pepper-pies#0/bake-pies",
        kind: "executing",
        subject: {
          kind: "workflow",
          instance: "steak-and-pepper-pies#0",
          key: "bake-pies",
        },
        startedAt: 0,
        completesAt: 2_100_000_000,
      },
    ],
    stores: [],
    resources: [],
  });

  const sampleAt = (fraction) => {
    const timeUs = Math.round(2_100_000_000 * fraction);
    const appliances = synchronizeMorningShiftAppliances(
      scenario,
      makeBakeLogistics(timeUs),
      timeUs,
      null,
    );
    factory.update(
      [{ id: "oven-pie-trays", capacity: 3, occupants: ["pie-tray-a"] }],
      [],
      appliances,
    );
    const tray = factory.root.getObjectByName("pie-tray-a");
    if (!tray) {
      throw new Error(`Missing pie-tray-a in FactoryStations at ${fraction}`);
    }
    const ovenApp = appliances.find((a) => a.appliance === "maruzen-mbco-5e");
    return {
      puffLiftMm: tray.userData.puffLiftMm,
      browningPct: tray.userData.browningPct,
      vertexCount: tray.userData.vertexCount,
      triangleCount: tray.userData.triangleCount,
      ovenTempC: ovenApp?.temperatureC ?? 0,
    };
  };

  const earlyBake = sampleAt(0.1);
  const midBake = sampleAt(0.55);
  const lateBake = sampleAt(1.0);
  factory.dispose();

  if (
    earlyBake.vertexCount !== 81 ||
    earlyBake.triangleCount !== 128 ||
    !(earlyBake.puffLiftMm < midBake.puffLiftMm) ||
    !(midBake.puffLiftMm < lateBake.puffLiftMm) ||
    !(earlyBake.browningPct < midBake.browningPct) ||
    !(midBake.browningPct < lateBake.browningPct) ||
    lateBake.puffLiftMm < 5.5 ||
    lateBake.browningPct < 90
  ) {
    throw new Error(
      `Expected monotonic progressive deformable puff lift & browning in FactoryStations: ${JSON.stringify({ earlyBake, midBake, lateBake })}`,
    );
  }

  return {
    stationsCount: PIE_STATIONS.length,
    earlyBake,
    midBake,
    lateBake,
  };
}

async function readStationState(station) {
  return {
    phase: await station.getAttribute("data-pastry-phase"),
    vertices: Number(await station.getAttribute("data-pastry-vertices")),
    triangles: Number(await station.getAttribute("data-pastry-triangles")),
    doughVertices: Number(
      await station.getAttribute("data-pastry-dough-vertices"),
    ),
    doughTriangles: Number(
      await station.getAttribute("data-pastry-dough-triangles"),
    ),
    doughHeightMm: Number(
      await station.getAttribute("data-pastry-dough-height-mm"),
    ),
    doughSpanMm: Number(
      await station.getAttribute("data-pastry-dough-span-mm"),
    ),
    drapeMm: Number(await station.getAttribute("data-pastry-drape-mm")),
    sealPct: Number(await station.getAttribute("data-pastry-seal-pct")),
    ovenC: Number(await station.getAttribute("data-pastry-oven-c")),
    browningPct: Number(await station.getAttribute("data-pastry-browning-pct")),
    puffLiftMm: Number(await station.getAttribute("data-pastry-puff-lift-mm")),
  };
}

async function openPastryBenchRecipeForm(page) {
  const form = page.getByRole("form", {
    name: "Pie pastry bench deformable recipe",
    exact: true,
  });
  if (await form.isVisible()) return;
  const pastryButton = page
    .getByRole("button", {
      name: /^Pie pastry/i,
    })
    .first();
  if (!(await pastryButton.isVisible())) {
    const workflowButton = page.getByRole("button", {
      name: "Workflow",
      exact: true,
    });
    await workflowButton.waitFor({ state: "visible", timeout: 15000 });
    await workflowButton.click();
  }
  await pastryButton.waitFor({ state: "visible", timeout: 15000 });
  await pastryButton.scrollIntoViewIfNeeded();
  await pastryButton.click();
  await form.waitFor({ state: "visible", timeout: 15000 });
}

async function openWorkspace(page) {
  await page.reload();
  await page.evaluate(mountWorkflowSimulator, { kind: "standalone" });
}

verifyPastryBenchBrowser;
