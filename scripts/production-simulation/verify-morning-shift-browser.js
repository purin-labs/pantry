async function verifyMorningShiftBrowser(page) {
  globalThis.ovenRecipeArchive = new Map();
  const initialUrl = new URL(page.url());
  await page.route(
    "**/v1/control/organisations/oven-ui-acceptance/bakery/runs**",
    recipeArchiveRequest,
  );
  if (initialUrl.pathname.endsWith("/workflow-preview.html")) {
    await page.route("**/@vite/client**", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
          export function createHotContext() {
            return {
              accept() {},
               acceptExports() {},
              dispose() {},
              prune() {},
              invalidate() {},
              decline() {},
              on() {},
              off() {},
              send() {},
              data: {},
            };
          }
          export function updateStyle(id, content) {
            let el = document.querySelector(\`style[data-vite-dev-id="\${id}"]\`);
            if (!el) {
              el = document.createElement("style");
              el.setAttribute("data-vite-dev-id", id);
              document.head.appendChild(el);
            }
            el.textContent = content;
          }
          export function removeStyle(id) {
            const el = document.querySelector(\`style[data-vite-dev-id="\${id}"]\`);
            if (el) el.remove();
          }
          export function injectQuery(url) {
            return url;
          }
        `,
      }),
    );
    await page.route("**/src/dev/workflow-preview.tsx", previewStyles);
    await page.reload();
    await installRecipeMutation(page);
    await page.evaluate(mountWorkflowSimulator, {
      kind: "workspace",
      organisationId: "oven-ui-acceptance",
      canManage: true,
    });
  } else {
    await page.route("**/v1/control/**", portalControlRequest);
    await page.goto(
      `${initialUrl.origin}/portal/nuki-inc/cafe-operations/workflow-simulator`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  const shiftForm = page.getByRole("form", { name: "Bakery shift", exact: true });
  await chooseOption(
    page,
    shiftForm.getByLabel("Shift scope", { exact: true }),
    { value: "morning-shift" },
  );
  await shiftForm.getByLabel("Financier trays", { exact: true }).fill("1");
  await chooseOption(
    page,
    shiftForm.getByLabel("Financier production waves", { exact: true }),
    { value: "2" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Wave cadence (minutes)", { exact: true }),
    { value: "45" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Silicone mould count", { exact: true }),
    { value: "2" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Cooling rack grids", { exact: true }),
    { value: "4" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Customer demand pattern", { exact: true }),
    { value: "rush" },
  );
  // The default threshold, as the old showcase-wide "12" was.
  await shiftForm
    .getByLabel("Financier reorder threshold (units per flavour)", {
      exact: true,
    })
    .fill("4");
  await chooseOption(
    page,
    shiftForm.getByLabel("Worker break policy", { exact: true }),
    { value: "staggered-relief" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Operator walk speed and aisle congestion", { exact: true }),
    { value: "standard" },
  );
  await shiftForm.getByLabel("Milk tea batches", { exact: true }).fill("2");
  await shiftForm.getByLabel("Black tea batches", { exact: true }).fill("2");
  await shiftForm
    .getByLabel("Sesame concentrate batches", { exact: true })
    .fill("2");
  await chooseOption(
    page,
    shiftForm.getByLabel("Sesame oven roast", { exact: true }),
    { value: "refresh" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Staffing comparison", { exact: true }),
    { value: "2" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Hob capacity comparison", { exact: true }),
    { value: "1" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Pan availability comparison", { exact: true }),
    { value: "4" },
  );
  await chooseOption(
    page,
    shiftForm.getByLabel("Sesame preparation timing", { exact: true }),
    { value: "baseline" },
  );
  await shiftForm.getByLabel("Espresso orders", { exact: true }).fill("2");
  await chooseOption(
    page,
    shiftForm.getByLabel("Espresso machine", { exact: true }),
    { value: "linea" },
  );
  await shiftForm.getByLabel("Pour-over orders", { exact: true }).fill("1");
  await chooseOption(
    page,
    shiftForm.getByLabel("Coffee grinder", { exact: true }),
    { value: "option-o-lagom-casa" },
  );
  await shiftForm.screenshot({ path: "morning-shift-author.png" });
  await shiftForm
    .getByRole("button", { name: "Prepare bakery shift", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  const transferExecuting = page
    .locator(
      '[data-task="load-hazelnut-a#0/transfer-cold-carrier"][data-kind="executing"]',
    )
    .first();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (await transferExecuting.isVisible()) break;
    const statusText =
      (await page
        .getByLabel("Execution status", { exact: true })
        .textContent()) ?? "";
    if (statusText.includes("awaiting-inspection")) {
      const row = page.locator('[data-inspection-state="pending"]').first();
      if (await row.isVisible()) {
        const task = await row.getAttribute("data-inspection-task");
        const decision = task === "load-coffee-a#0/inspect-bake" ? "Reject" : "Accept";
        await page
          .getByLabel("Inspection observation", { exact: true })
          .fill(
            `${decision}: Morning shift acceptance review for ${task}.`,
          );
        await row.getByRole("button", { name: decision, exact: true }).click();
      }
    }
    await page.waitForTimeout(150);
  }
  await transferExecuting.waitFor({ timeout: 5000 });
  await page
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page
    .getByLabel("Execution status", { exact: true })
    .filter({ hasText: "paused" })
    .waitFor();
  await page
    .getByRole("region", { name: "Production overview", exact: true })
    .screenshot({ path: "morning-shift-paused-overview.png" });
  await page
    .locator('[aria-label="Live accepted physics"][data-scene="ready"]')
    .waitFor();
  await page
    .locator(
      '.factory-appliance-strip[aria-label="Synchronized appliance and cobot states"]',
    )
    .waitFor();
  const facilityUtility = await page
    .locator('[data-sync-kind="facility-utility"]')
    .evaluate((node) => ({
      status: node.getAttribute("data-utility-status"),
      powerWatts: Number(node.getAttribute("data-utility-power-watts") ?? "0"),
      voltageVolts: Number(
        node.getAttribute("data-utility-voltage-volts") ?? "0",
      ),
      waterPressureBar: Number(
        node.getAttribute("data-utility-water-pressure-bar") ?? "0",
      ),
      waterFlowLpm: Number(
        node.getAttribute("data-utility-water-flow-lpm") ?? "0",
      ),
      hvacStatus: node.getAttribute("data-hvac-status"),
      hvacDryBulbC: Number(
        node.getAttribute("data-hvac-dry-bulb-c") ?? "0",
      ),
      hvacRelativeHumidityPct: Number(
        node.getAttribute("data-hvac-rh-pct") ?? "0",
      ),
      hvacWetBulbC: Number(
        node.getAttribute("data-hvac-wet-bulb-c") ?? "0",
      ),
      hvacDewPointC: Number(
        node.getAttribute("data-hvac-dew-point-c") ?? "0",
      ),
      hvacEnthalpyKjKg: Number(
        node.getAttribute("data-hvac-enthalpy-kj-kg") ?? "0",
      ),
      hvacHoodCfm: Number(
        node.getAttribute("data-hvac-hood-cfm") ?? "0",
      ),
      acousticsRoomDba: Number(
        node.getAttribute("data-acoustics-room-dba") ?? "0",
      ),
      vibrationPeakMms: Number(
        node.getAttribute("data-vibration-peak-mms") ?? "0",
      ),
      vibrationIsoClass: node.getAttribute("data-vibration-iso-class"),
      chillerPhase: node.getAttribute("data-chiller-phase"),
      chillerInfiltrationKj: Number(
        node.getAttribute("data-chiller-infiltration-kj") ?? "0",
      ),
      chillerFrostG: Number(node.getAttribute("data-chiller-frost-g") ?? "0"),
      chillerDefrostCycles: Number(
        node.getAttribute("data-chiller-defrost-cycles") ?? "0",
      ),
      chillerCondensateMl: Number(
        node.getAttribute("data-chiller-condensate-ml") ?? "0",
      ),
      dishwasherSanitizerPpm: Number(
        node.getAttribute("data-dishwasher-sanitizer-ppm") ?? "0",
      ),
      dishwasherDetergentMl: Number(
        node.getAttribute("data-dishwasher-detergent-ml") ?? "0",
      ),
      dishwasherHeatRecoveredKj: Number(
        node.getAttribute("data-dishwasher-heat-recovered-kj") ?? "0",
      ),
      dishwasherRecoveryEfficiencyPct: Number(
        node.getAttribute("data-dishwasher-recovery-efficiency-pct") ?? "0",
      ),
      espressoMinGroupheadC: Number(
        node.getAttribute("data-espresso-min-grouphead-c") ?? "0",
      ),
      espressoThermalDipC: Number(
        node.getAttribute("data-espresso-thermal-dip-c") ?? "0",
      ),
      espressoSteamPressureBar: Number(
        node.getAttribute("data-espresso-steam-pressure-bar") ?? "0",
      ),
      ovenNominalFluxKwM2: Number(
        node.getAttribute("data-oven-nominal-flux-kw-m2") ?? "0",
      ),
      ovenHotspotFluxKwM2: Number(
        node.getAttribute("data-oven-hotspot-flux-kw-m2") ?? "0",
      ),
      ovenVentingGps: Number(
        node.getAttribute("data-oven-venting-gps") ?? "0",
      ),
      hobCouplingEfficiencyPct: Number(
        node.getAttribute("data-hob-coupling-efficiency-pct") ?? "0",
      ),
      hobRadialGradientC: Number(
        node.getAttribute("data-hob-radial-gradient-c") ?? "0",
      ),
      hobBoilOffGps: Number(
        node.getAttribute("data-hob-boil-off-gps") ?? "0",
      ),
      scaleSettlingS: Number(
        node.getAttribute("data-scale-settling-s") ?? "0",
      ),
      scaleTareDriftMg: Number(
        node.getAttribute("data-scale-tare-drift-mg") ?? "0",
      ),
      scaleDraftRejectionDb: Number(
        node.getAttribute("data-scale-draft-rejection-db") ?? "0",
      ),
      mixerWorkWhKg: Number(
        node.getAttribute("data-mixer-work-wh-kg") ?? "0",
      ),
      mixerTorqueRippleNm: Number(
        node.getAttribute("data-mixer-torque-ripple-nm") ?? "0",
      ),
      mixerEmulsionIndex: Number(
        node.getAttribute("data-mixer-emulsion-index") ?? "0",
      ),
      frotherOverrunPct: Number(
        node.getAttribute("data-frother-overrun-pct") ?? "0",
      ),
      frotherShearInvS: Number(
        node.getAttribute("data-frother-shear-inv-s") ?? "0",
      ),
      frotherWheyDenaturationPct: Number(
        node.getAttribute("data-frother-whey-denaturation-pct") ?? "0",
      ),
      waveActive: Number(node.getAttribute("data-wave-active") ?? "0"),
      waveTotal: Number(node.getAttribute("data-wave-total") ?? "0"),
      carrierTurnarounds: Number(
        node.getAttribute("data-carrier-turnarounds") ?? "0",
      ),
      carrierWashCycles: Number(
        node.getAttribute("data-carrier-wash-cycles") ?? "0",
      ),
      carrierReuseRatio: Number(
        node.getAttribute("data-carrier-reuse-ratio") ?? "0",
      ),
      handoffCount: Number(node.getAttribute("data-handoff-count") ?? "0"),
      breakCoveragePct: Number(
        node.getAttribute("data-break-coverage-pct") ?? "0",
      ),
      handoffMeanS: Number(node.getAttribute("data-handoff-mean-s") ?? "0"),
      walkSpeedMps: Number(node.getAttribute("data-walk-speed-mps") ?? "0"),
      aisleTransits: Number(node.getAttribute("data-aisle-transits") ?? "0"),
      aisleDistanceM: Number(node.getAttribute("data-aisle-distance-m") ?? "0"),
      aisleCongestionWaitS: Number(
        node.getAttribute("data-aisle-congestion-wait-s") ?? "0",
      ),
      massAcceptedG: Number(node.getAttribute("data-mass-accepted-g") ?? "0"),
      massRejectedScrapG: Number(
        node.getAttribute("data-mass-rejected-scrap-g") ?? "0",
      ),
      massYieldPct: Number(node.getAttribute("data-mass-yield-pct") ?? "0"),
      text: node.textContent?.trim() ?? "",
    }));
  if (
    facilityUtility.powerWatts <= 0 ||
    facilityUtility.voltageVolts < 190 ||
    facilityUtility.waterPressureBar <= 1.5 ||
    facilityUtility.hvacDryBulbC < 20 ||
    facilityUtility.hvacRelativeHumidityPct < 40 ||
    facilityUtility.hvacHoodCfm < 400 ||
    facilityUtility.acousticsRoomDba < 48 ||
    facilityUtility.vibrationPeakMms <= 0 ||
    facilityUtility.chillerInfiltrationKj <= 0 ||
    facilityUtility.chillerDefrostCycles < 1 ||
    facilityUtility.chillerCondensateMl <= 0 ||
    facilityUtility.dishwasherSanitizerPpm < 65 ||
    facilityUtility.dishwasherDetergentMl < 25 ||
    facilityUtility.dishwasherHeatRecoveredKj < 800 ||
    facilityUtility.dishwasherRecoveryEfficiencyPct < 50 ||
    facilityUtility.espressoMinGroupheadC < 91.5 ||
    facilityUtility.espressoThermalDipC < 0.4 ||
    facilityUtility.espressoSteamPressureBar < 1.05 ||
    facilityUtility.ovenNominalFluxKwM2 < 4.0 ||
    facilityUtility.ovenHotspotFluxKwM2 < 6.0 ||
    facilityUtility.ovenVentingGps < 0.6 ||
    facilityUtility.hobCouplingEfficiencyPct < 80 ||
    facilityUtility.hobRadialGradientC < 5.0 ||
    facilityUtility.hobBoilOffGps < 0.5 ||
    facilityUtility.scaleSettlingS < 0.7 ||
    facilityUtility.scaleTareDriftMg <= 0 ||
    facilityUtility.scaleDraftRejectionDb < 35 ||
    facilityUtility.mixerWorkWhKg < 1.0 ||
    facilityUtility.mixerTorqueRippleNm < 1.0 ||
    facilityUtility.mixerEmulsionIndex < 0.8 ||
    facilityUtility.frotherOverrunPct < 35 ||
    facilityUtility.frotherShearInvS < 1400 ||
    facilityUtility.frotherWheyDenaturationPct < 55 ||
    facilityUtility.waveActive < 1 ||
    facilityUtility.waveTotal < 2 ||
    facilityUtility.carrierTurnarounds < 20 ||
    facilityUtility.carrierWashCycles < 20 ||
    facilityUtility.carrierReuseRatio < 2.0 ||
    facilityUtility.handoffCount < 4 ||
    facilityUtility.breakCoveragePct < 95 ||
    facilityUtility.handoffMeanS < 10 ||
    facilityUtility.walkSpeedMps < 0.8 ||
    facilityUtility.aisleTransits < 30 ||
    facilityUtility.aisleDistanceM < 200 ||
    facilityUtility.aisleCongestionWaitS < 10 ||
    facilityUtility.massAcceptedG <= 0 ||
    facilityUtility.massRejectedScrapG <= 0
  ) {
    throw new Error(
      `Invalid facility utility / HVAC / acoustics / chiller / dishwasher / espresso / oven / hob / scale / mixer / frother / mass accounting telemetry: ${JSON.stringify(facilityUtility)}`,
    );
  }
  const cobotTransfers = await page
    .locator('[data-sync-kind="cobot"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        cell: node.getAttribute("data-cobot-cell"),
        status: node.getAttribute("data-sync-status"),
        gripperForceNewtons: Number(
          node.getAttribute("data-cobot-gripper-force-n") ?? "0",
        ),
        shoulderTorqueNm: Number(
          node.getAttribute("data-cobot-shoulder-torque-nm") ?? "0",
        ),
        payloadMassKg: Number(
          node.getAttribute("data-cobot-payload-kg") ?? "0",
        ),
        jointsRad: (node.getAttribute("data-cobot-joints-rad") ?? "")
          .split(",")
          .filter(Boolean)
          .map(Number),
        text: node.textContent?.trim() ?? "",
      })),
    );
  for (const ct of cobotTransfers) {
    if (ct.jointsRad.length !== 6 || ct.shoulderTorqueNm <= 0) {
      throw new Error(
        `Expected 6-DOF IK joints and positive shoulder torque on ${ct.cell}, got ${JSON.stringify(ct)}`,
      );
    }
  }
  const appliances = await page
    .locator('[data-sync-kind="appliance"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        appliance: node.getAttribute("data-appliance"),
        status: node.getAttribute("data-sync-status"),
        powerWatts: Number(node.getAttribute("data-appliance-power-watts") ?? "0"),
        pressureBar: Number(node.getAttribute("data-appliance-pressure-bar") ?? "0"),
        torqueNm: Number(node.getAttribute("data-appliance-torque-nm") ?? "0"),
        viscosityPas: Number(node.getAttribute("data-appliance-viscosity-pas") ?? "0"),
        noiseDba: Number(node.getAttribute("data-appliance-noise-dba") ?? "0"),
        vibrationMms: Number(
          node.getAttribute("data-appliance-vibration-mms") ?? "0",
        ),
        peakNoiseDba: Number(
          node.getAttribute("data-appliance-peak-noise-dba") ?? "0",
        ),
        peakVibrationMms: Number(
          node.getAttribute("data-appliance-peak-vibration-mms") ?? "0",
        ),
        doorOpenRatio: Number(node.getAttribute("data-appliance-door-open") ?? "0"),
        text: node.textContent?.trim() ?? "",
      })),
    );
  const sceneCells = await page
    .locator('button.factory-station-label[data-cell]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        cell: node.getAttribute("data-cell"),
        status: node.getAttribute("data-cobot-status"),
        text: node.textContent?.trim() ?? "",
      })),
    );
  const expectedCells = ["tea-pan-cell", "espresso-cell", "pour-over-cell"];
  const stripCells = cobotTransfers.map((c) => c.cell);
  if (
    cobotTransfers.length !== 3 ||
    expectedCells.some((cell) => !stripCells.includes(cell))
  )
    throw new Error(
      `Expected 3 cobot cells (${expectedCells.join(", ")}) in strip, got ${JSON.stringify(cobotTransfers)}`,
    );
  const labelCells = sceneCells.map((c) => c.cell);
  if (
    sceneCells.length !== 3 ||
    expectedCells.some((cell) => !labelCells.includes(cell))
  )
    throw new Error(
      `Expected 3 cobot scene labels (${expectedCells.join(", ")}), got ${JSON.stringify(sceneCells)}`,
    );
  if (appliances.length !== 11)
    throw new Error(
      `Expected 11 synchronized Morning Shift appliances, got ${appliances.length}`,
    );
  await page
    .getByLabel("Live accepted physics", { exact: true })
    .screenshot({ path: "morning-shift-native-transfer.png" });

  // Mid-cycle appliance fault injection & checkpoint-restore journey
  await page.locator('[data-appliance="hobart-hl200"]').click();
  await page
    .locator('section[aria-label="Rotary acoustic and vibration telemetry"]')
    .waitFor();
  const inspectorRotaryTelemetry = await page
    .locator('tr[data-rotary-appliance]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        appliance: node.getAttribute("data-rotary-appliance"),
        rpm: Number(node.getAttribute("data-rotary-rpm") ?? "0"),
        liveDba: Number(node.getAttribute("data-rotary-live-dba") ?? "0"),
        liveVibMms: Number(node.getAttribute("data-rotary-live-vib-mms") ?? "0"),
        peakDba: Number(node.getAttribute("data-rotary-peak-dba") ?? "0"),
        peakVibMms: Number(node.getAttribute("data-rotary-peak-vib-mms") ?? "0"),
        text: node.textContent?.trim() ?? "",
      })),
    );
  const activeRotaryItems = inspectorRotaryTelemetry.filter((r) =>
    [
      "hobart-hl200",
      "waring-wsg60",
      "la-marzocco-linea-classic-s-2g",
    ].includes(r.appliance ?? ""),
  );
  // The sesame concentrate is blended the day before, so the blender stays
  // idle during the morning.
  const morningBlender = inspectorRotaryTelemetry.find(
    (r) => r.appliance === "vitamix-quiet-one",
  );
  if (
    inspectorRotaryTelemetry.length < 5 ||
    activeRotaryItems.length !== 3 ||
    activeRotaryItems.some((r) => r.peakDba < 68 || r.peakVibMms < 2.5) ||
    morningBlender === undefined ||
    morningBlender.peakVibMms >= 1
  ) {
    throw new Error(
      `Expected rotary appliances with acoustic (dBA) & vibration (mm/s RMS) telemetry in Inspector, got ${JSON.stringify(inspectorRotaryTelemetry)}`,
    );
  }
  await page
    .locator('section[aria-label="Batch rework and scrap mass accounting"]')
    .waitFor();
  const inspectorMassAccounting = await page
    .locator('tr[data-mass-lot]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        batchId: node.getAttribute("data-mass-lot"),
        gateKind: node.getAttribute("data-mass-lot-gate"),
        outcome: node.getAttribute("data-mass-lot-outcome"),
        acceptedGrams: Number(
          node.getAttribute("data-mass-lot-accepted-g") ?? "0",
        ),
        rejectedScrapGrams: Number(
          node.getAttribute("data-mass-lot-rejected-g") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  const rejectedLoadB = inspectorMassAccounting.find(
    (m) => m.batchId === "load-coffee-a#0",
  );
  if (
    inspectorMassAccounting.length < 7 ||
    !rejectedLoadB ||
    rejectedLoadB.outcome !== "rejected-rework" ||
    rejectedLoadB.rejectedScrapGrams !== 188
  ) {
    throw new Error(
      `Expected Batch rework & scrap mass accounting in Inspector with load-coffee-a#0 188g scrap, got ${JSON.stringify(inspectorMassAccounting)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Hoshizaki cold-cell defrost and door infiltration telemetry"]',
    )
    .waitFor();
  const inspectorChillerColdCell = await page
    .locator('tr[data-chiller-event]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-chiller-event"),
        phase: node.getAttribute("data-chiller-event-phase"),
        infiltrationKj: Number(
          node.getAttribute("data-chiller-event-infiltration-kj") ?? "0",
        ),
        peakC: Number(node.getAttribute("data-chiller-event-peak-c") ?? "0"),
        defrostTriggered:
          node.getAttribute("data-chiller-event-defrost") === "true",
        condensateMl: Number(
          node.getAttribute("data-chiller-event-condensate-ml") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  const defrostEvents = inspectorChillerColdCell.filter(
    (e) => e.defrostTriggered && e.condensateMl > 0,
  );
  if (
    inspectorChillerColdCell.length !== 4 ||
    defrostEvents.length !== 2 ||
    inspectorChillerColdCell.some(
      (e) => e.infiltrationKj <= 0 || e.peakC < 6.0,
    )
  ) {
    throw new Error(
      `Expected Hoshizaki cold-cell defrost & door infiltration events in Inspector, got ${JSON.stringify(inspectorChillerColdCell)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Winterhalter dishwasher dosing and greywater heat recovery telemetry"]',
    )
    .waitFor();
  const inspectorDishwasherWarewash = await page
    .locator('tr[data-dishwasher-cycle]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-dishwasher-cycle"),
        soilLoadCategory: node.getAttribute("data-dishwasher-soil"),
        sanitizerPpm: Number(
          node.getAttribute("data-dishwasher-cycle-ppm") ?? "0",
        ),
        heatRecoveredKj: Number(
          node.getAttribute("data-dishwasher-cycle-recovered-kj") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorDishwasherWarewash.length !== 4 ||
    inspectorDishwasherWarewash.some(
      (c) => c.sanitizerPpm < 65 || c.heatRecoveredKj < 200,
    )
  ) {
    throw new Error(
      `Expected Winterhalter dishwasher dosing & greywater heat recovery telemetry in Inspector, got ${JSON.stringify(inspectorDishwasherWarewash)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="La Marzocco espresso boiler and grouphead thermal stability telemetry"]',
    )
    .waitFor();
  const inspectorEspressoBoiler = await page
    .locator('tr[data-espresso-shot]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-espresso-shot"),
        grouphead: node.getAttribute("data-espresso-grouphead"),
        groupheadMinC: Number(
          node.getAttribute("data-espresso-grouphead-min-c") ?? "0",
        ),
        thermalDipC: Number(
          node.getAttribute("data-espresso-shot-dip-c") ?? "0",
        ),
        steamBoilerPressureBar: Number(
          node.getAttribute("data-espresso-shot-steam-bar") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorEspressoBoiler.length !== 2 ||
    inspectorEspressoBoiler.some(
      (s) =>
        s.groupheadMinC < 91.5 ||
        s.thermalDipC < 0.35 ||
        s.steamBoilerPressureBar < 1.05,
    )
  ) {
    throw new Error(
      `Expected La Marzocco espresso boiler & grouphead telemetry in Inspector, got ${JSON.stringify(inspectorEspressoBoiler)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Maruzen convection oven venting and deck radiant heat flux telemetry"]',
    )
    .waitFor();
  const inspectorOvenVentingRadiant = await page
    .locator('tr[data-oven-deck]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-oven-deck"),
        deckZone: node.getAttribute("data-oven-deck-zone"),
        totalFluxKwM2: Number(
          node.getAttribute("data-oven-deck-flux-kw-m2") ?? "0",
        ),
        steamVentingGps: Number(
          node.getAttribute("data-oven-deck-vent-gps") ?? "0",
        ),
        surfaceWaterActivityAw: Number(
          node.getAttribute("data-oven-deck-aw") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  const hotspotDeck = inspectorOvenVentingRadiant.find(
    (d) => d.deckZone === "middle-rear-hotspot",
  );
  if (
    inspectorOvenVentingRadiant.length !== 4 ||
    !hotspotDeck ||
    hotspotDeck.totalFluxKwM2 < 6.0 ||
    hotspotDeck.surfaceWaterActivityAw > 0.36
  ) {
    throw new Error(
      `Expected Maruzen convection oven venting & deck radiant flux telemetry in Inspector, got ${JSON.stringify(inspectorOvenVentingRadiant)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Induction hob coil coupling and pan thermal gradient telemetry"]',
    )
    .waitFor();
  const inspectorHobCoilThermal = await page
    .locator('tr[data-hob-cycle]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-hob-cycle"),
        appliance: node.getAttribute("data-hob-appliance"),
        couplingEfficiencyPct: Number(
          node.getAttribute("data-hob-coupling-efficiency") ?? "0",
        ),
        radialGradientC: Number(
          node.getAttribute("data-hob-radial-gradient-c") ?? "0",
        ),
        boilOffGps: Number(
          node.getAttribute("data-hob-boil-off-gps") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorHobCoilThermal.length !== 4 ||
    inspectorHobCoilThermal.some(
      (c) =>
        c.couplingEfficiencyPct < 80 ||
        c.radialGradientC < 5.0 ||
        c.boilOffGps < 0.4,
    )
  ) {
    throw new Error(
      `Expected Induction hob coil coupling & pan thermal gradient telemetry in Inspector, got ${JSON.stringify(inspectorHobCoilThermal)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Ohaus Ranger 3000 load-cell settling and air-draft telemetry"]',
    )
    .waitFor();
  const inspectorPrecisionScale = await page
    .locator('tr[data-scale-weigh]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-scale-weigh"),
        settlingSeconds: Number(
          node.getAttribute("data-scale-settling-s") ?? "0",
        ),
        tareDriftMg: Number(
          node.getAttribute("data-scale-tare-drift-mg") ?? "0",
        ),
        draftRejectionDb: Number(
          node.getAttribute("data-scale-draft-rejection-db") ?? "0",
        ),
        stability: node.getAttribute("data-scale-stability"),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorPrecisionScale.length !== 4 ||
    inspectorPrecisionScale.some(
      (w) =>
        w.settlingSeconds < 0.7 ||
        w.tareDriftMg <= 0 ||
        w.draftRejectionDb < 35,
    )
  ) {
    throw new Error(
      `Expected Ohaus Ranger 3000 load-cell settling & air-draft telemetry in Inspector, got ${JSON.stringify(inspectorPrecisionScale)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Hobart HL200 planetary mixer rheology and torque ripple telemetry"]',
    )
    .waitFor();
  const inspectorPlanetaryMixer = await page
    .locator('tr[data-mixer-cycle]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-mixer-cycle"),
        mixStage: node.getAttribute("data-mixer-stage"),
        specificWorkWhPerKg: Number(
          node.getAttribute("data-mixer-cycle-work-wh-kg") ?? "0",
        ),
        torqueRippleNm: Number(
          node.getAttribute("data-mixer-cycle-ripple-nm") ?? "0",
        ),
        emulsionIndex: Number(
          node.getAttribute("data-mixer-cycle-emulsion") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorPlanetaryMixer.length !== 2 ||
    inspectorPlanetaryMixer.some(
      (c) =>
        c.specificWorkWhPerKg < 0.3 ||
        c.torqueRippleNm < 0.5 ||
        c.emulsionIndex < 0.7,
    )
  ) {
    throw new Error(
      `Expected Hobart HL200 planetary mixer rheology & torque ripple telemetry in Inspector, got ${JSON.stringify(inspectorPlanetaryMixer)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Severin SM 3587 microfoam overrun and whey protein telemetry"]',
    )
    .waitFor();
  const inspectorMilkFrother = await page
    .locator('tr[data-frother-cycle]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        taskId: node.getAttribute("data-frother-cycle"),
        overrunPercent: Number(
          node.getAttribute("data-frother-overrun-pct") ?? "0",
        ),
        vortexShearInvS: Number(
          node.getAttribute("data-frother-shear-inv-s") ?? "0",
        ),
        wheyDenaturationPercent: Number(
          node.getAttribute("data-frother-whey-pct") ?? "0",
        ),
        windowStatus: node.getAttribute("data-frother-window"),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorMilkFrother.length !== 2 ||
    inspectorMilkFrother.some(
      (c) =>
        c.overrunPercent < 35 ||
        c.vortexShearInvS < 1400 ||
        c.wheyDenaturationPercent < 55,
    )
  ) {
    throw new Error(
      `Expected Severin SM 3587 microfoam overrun & whey protein telemetry in Inspector, got ${JSON.stringify(inspectorMilkFrother)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Continuous production waves and carrier return telemetry"]',
    )
    .waitFor();
  const inspectorContinuousWaveCarrierReturn = await page
    .locator('tr[data-carrier-pool]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        poolId: node.getAttribute("data-carrier-pool"),
        carrierCount: Number(node.getAttribute("data-carrier-count") ?? "0"),
        acquisitions: Number(
          node.getAttribute("data-carrier-acquisitions") ?? "0",
        ),
        washCycles: Number(
          node.getAttribute("data-carrier-wash-cycles") ?? "0",
        ),
        returns: Number(node.getAttribute("data-carrier-returns") ?? "0"),
        reuseRatio: Number(
          node.getAttribute("data-carrier-reuse-ratio") ?? "0",
        ),
        turnaroundSeconds: Number(
          node.getAttribute("data-carrier-turnaround-s") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorContinuousWaveCarrierReturn.length !== 6 ||
    inspectorContinuousWaveCarrierReturn.some(
      (p) =>
        p.carrierCount < 1 ||
        p.returns < 2 ||
        p.reuseRatio < 1.5 ||
        p.turnaroundSeconds <= 0,
    )
  ) {
    throw new Error(
      `Expected Continuous production waves & carrier return telemetry in Inspector, got ${JSON.stringify(inspectorContinuousWaveCarrierReturn)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Shift break relief and station handoff telemetry"]',
    )
    .waitFor();
  const inspectorShiftBreakHandoff = await page
    .locator('tr[data-shift-handoff]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        handoffId: node.getAttribute("data-shift-handoff"),
        stationId: node.getAttribute("data-handoff-station"),
        durationSeconds: Number(
          node.getAttribute("data-handoff-duration-s") ?? "0",
        ),
        status: node.getAttribute("data-handoff-status"),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorShiftBreakHandoff.length !== 4 ||
    inspectorShiftBreakHandoff.some((h) => h.durationSeconds < 10)
  ) {
    throw new Error(
      `Expected Shift break relief & station handoff telemetry in Inspector, got ${JSON.stringify(inspectorShiftBreakHandoff)}`,
    );
  }
  await page
    .locator(
      'section[aria-label="Operator walk speed and aisle congestion telemetry"]',
    )
    .waitFor();
  const inspectorAisleWalkCongestion = await page
    .locator('tr[data-aisle-transit]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        transitId: node.getAttribute("data-aisle-transit"),
        distanceMeters: Number(
          node.getAttribute("data-transit-distance-m") ?? "0",
        ),
        walkSeconds: Number(node.getAttribute("data-transit-walk-s") ?? "0"),
        yieldSeconds: Number(node.getAttribute("data-transit-yield-s") ?? "0"),
        effectiveSpeedMps: Number(
          node.getAttribute("data-transit-speed-mps") ?? "0",
        ),
        text: node.textContent?.trim() ?? "",
      })),
    );
  if (
    inspectorAisleWalkCongestion.length !== 5 ||
    inspectorAisleWalkCongestion.some(
      (t) => t.distanceMeters <= 0 || t.effectiveSpeedMps <= 0,
    )
  ) {
    throw new Error(
      `Expected Operator walk speed & aisle congestion telemetry in Inspector, got ${JSON.stringify(inspectorAisleWalkCongestion)}`,
    );
  }
  const injectBtn = page.locator(
    '[data-appliance-fault-action="inject"][data-fault-appliance="hobart-hl200"]',
  );
  await injectBtn.waitFor();
  await injectBtn.click();

  await page
    .locator(
      '[data-appliance="hobart-hl200"][data-sync-status="fault"][data-appliance-door-open="1"]',
    )
    .waitFor();
  await page
    .locator(
      'button.factory-station-label[data-station="station-mixer"][data-appliance-status="fault"]',
    )
    .waitFor();
  for (const cellId of expectedCells) {
    await page
      .locator(
        `[data-sync-kind="cobot"][data-cobot-cell="${cellId}"][data-sync-status="cascade-held"][data-cascade-status="held"]`,
      )
      .waitFor();
    await page
      .locator(
        `button.factory-station-label[data-cell="${cellId}"][data-cobot-status="cascade-held"][data-cascade-status="held"]`,
      )
      .first()
      .waitFor();
  }
  await page.locator('[data-cascade-summary="held"]').waitFor();
  const heldBatchRows = await page
    .locator('tr[data-cascade-batch][data-cascade-batch-status="held"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        batchId: node.getAttribute("data-cascade-batch"),
        cellId: node.getAttribute("data-cascade-batch-cell"),
        status: node.getAttribute("data-cascade-batch-status"),
      })),
    );
  if (heldBatchRows.length < 6) {
    throw new Error(
      `Expected at least 6 multi-batch cascade rows in held state, got ${heldBatchRows.length}`,
    );
  }
  const faultCheckpointDigest = await page
    .locator('tr[data-station-appliance="hobart-hl200"] [data-checkpoint-digest]')
    .getAttribute("data-checkpoint-digest");
  if (!faultCheckpointDigest)
    throw new Error("Expected fault checkpoint digest on hobart-hl200 row");
  const faultedMixerLabel =
    (await page
      .locator('button.factory-station-label[data-station="station-mixer"]')
      .textContent()) ?? "";
  await page
    .getByLabel("Live accepted physics", { exact: true })
    .screenshot({ path: "morning-shift-appliance-fault.png" });

  // Chat-proposed appliance fault recovery journey (propose -> discard -> re-propose -> confirm)
  const proposeChatBtn = page.locator(
    '[data-appliance-fault-action="propose-chat"][data-fault-appliance="hobart-hl200"]',
  );
  await proposeChatBtn.waitFor();
  await proposeChatBtn.click();

  const chatProposalSection = page.locator(
    'section[aria-label="Reviewed chat production control"][data-chat-proposal-kind="recover-appliance-fault"]',
  );
  await chatProposalSection.waitFor();
  const discardedProposalDigest = await chatProposalSection.getAttribute(
    "data-chat-proposal-digest",
  );
  if (!discardedProposalDigest || !/^[0-9a-f]{64}$/.test(discardedProposalDigest))
    throw new Error(
      `Expected 64-char SHA-256 chat proposal digest, got ${discardedProposalDigest}`,
    );
  // Preparation alone must not mutate the fault or release held cobot cells
  await page
    .locator(
      '[data-appliance="hobart-hl200"][data-sync-status="fault"][data-appliance-door-open="1"]',
    )
    .waitFor();
  await page.locator('[data-cascade-summary="held"]').waitFor();

  await page.locator('[data-chat-proposal-action="discard"]').click();
  await chatProposalSection.waitFor({ state: "hidden" });
  await page
    .locator(
      '[data-appliance="hobart-hl200"][data-sync-status="fault"][data-appliance-door-open="1"]',
    )
    .waitFor();
  await page.locator('[data-cascade-summary="held"]').waitFor();

  await proposeChatBtn.click();
  await chatProposalSection.waitFor();
  const confirmedProposalDigest = await chatProposalSection.getAttribute(
    "data-chat-proposal-digest",
  );
  if (!confirmedProposalDigest || !/^[0-9a-f]{64}$/.test(confirmedProposalDigest))
    throw new Error(
      `Expected 64-char SHA-256 confirmed chat proposal digest, got ${confirmedProposalDigest}`,
    );
  await page
    .getByRole("complementary", { name: "Factory details", exact: true })
    .screenshot({ path: "morning-shift-chat-fault-proposal.png" });

  await page.locator('[data-chat-proposal-action="confirm"]').click();
  await chatProposalSection.waitFor({ state: "hidden" });

  await page
    .locator(
      '[data-appliance="hobart-hl200"][data-sync-status="completed"][data-appliance-door-open="0"]',
    )
    .waitFor();
  for (const cellId of expectedCells) {
    await page
      .locator(
        `[data-sync-kind="cobot"][data-cobot-cell="${cellId}"][data-cascade-status="recovered"]`,
      )
      .waitFor();
    await page
      .locator(
        `button.factory-station-label[data-cell="${cellId}"][data-cascade-status="recovered"]`,
      )
      .first()
      .waitFor();
  }
  await page.locator('[data-cascade-summary="recovered"]').waitFor();
  const recoveredBatchRows = await page
    .locator('tr[data-cascade-batch][data-cascade-batch-status="recovered"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        batchId: node.getAttribute("data-cascade-batch"),
        cellId: node.getAttribute("data-cascade-batch-cell"),
        status: node.getAttribute("data-cascade-batch-status"),
      })),
    );
  if (recoveredBatchRows.length !== heldBatchRows.length) {
    throw new Error(
      `Expected ${heldBatchRows.length} recovered batch rows, got ${recoveredBatchRows.length}`,
    );
  }
  const restoredDigest = await page
    .locator(
      'tr[data-station-appliance="hobart-hl200"] [data-checkpoint-restored]',
    )
    .getAttribute("data-checkpoint-restored");
  if (restoredDigest !== faultCheckpointDigest)
    throw new Error(
      `Expected restored checkpoint digest ${faultCheckpointDigest}, got ${restoredDigest}`,
    );
  const restoredMixerPillText =
    (await page.locator('[data-appliance="hobart-hl200"]').textContent()) ?? "";
  await page
    .getByLabel("Live accepted physics", { exact: true })
    .screenshot({ path: "morning-shift-appliance-restored.png" });

  return {
    result: "passed",
    scope: "morning-shift",
    pausedTask: "load-hazelnut-a#0/transfer-cold-carrier",
    facilityUtility,
    inspectorRotaryTelemetry,
    inspectorMassAccounting,
    inspectorChillerColdCell,
    inspectorDishwasherWarewash,
    inspectorEspressoBoiler,
    inspectorOvenVentingRadiant,
    inspectorHobCoilThermal,
    inspectorPrecisionScale,
    inspectorPlanetaryMixer,
    inspectorMilkFrother,
    inspectorContinuousWaveCarrierReturn,
    inspectorShiftBreakHandoff,
    inspectorAisleWalkCongestion,
    cobotTransfers,
    sceneCells,
    appliances,
    applianceFaultRestore: {
      appliance: "hobart-hl200",
      faultCode: "GUARD_OPEN",
      faultCheckpointDigest,
      restoredCheckpointDigest: restoredDigest,
      faultedMixerLabel: faultedMixerLabel.trim(),
      restoredMixerPillText: restoredMixerPillText.trim(),
      multiBatchCascade: {
        linkedCells: expectedCells,
        heldBatchCount: heldBatchRows.length,
        recoveredBatchCount: recoveredBatchRows.length,
        batches: recoveredBatchRows,
      },
      chatProposedRecovery: {
        controlKind: "recover-appliance-fault",
        discardedProposalDigest,
        confirmedProposalDigest,
        verifiedHoldBeforeConfirm: true,
        verifiedHoldAfterDiscard: true,
      },
    },
  };
}

async function recipeArchiveRequest(route) {
  const archive = globalThis.ovenRecipeArchive;
  const request = route.request();
  const url = new URL(request.url());
  const prefix = "/v1/control/organisations/oven-ui-acceptance/bakery/runs";
  const id = decodeURIComponent(
    url.pathname.slice(prefix.length).replace(/^\//, ""),
  );
  if (request.method() === "POST") {
    const body = request.postDataJSON();
    const content = body.content;
    const summary = {
      id: body.snapshot,
      name: body.name,
      route: "oven-rack",
      executionId: body.executionId,
      parentSnapshotId: body.parentSnapshot,
      status: body.status,
      logicalTimeMicroseconds: body.logicalTimeMicroseconds,
      eventSequence: body.eventSequence,
      savedAt: "2026-10-24T09:00:00.000Z",
      byteLength: content.length,
    };
    const existed = archive.has(body.snapshot);
    archive.set(body.snapshot, { summary, content });
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

async function portalControlRequest(route) {
  const url = new URL(route.request().url());
  const { pathname } = url;
  if (
    pathname.startsWith("/v1/control/organisations/oven-ui-acceptance/bakery/runs")
  ) {
    await recipeArchiveRequest(route);
    return;
  }
  const userId = "user_00000000-0000-4000-8000-000000000001";
  const organisationId = "oven-ui-acceptance";
  if (pathname === "/v1/control/session") {
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        identity: {
          userId,
          email: "pta@pantry.test",
          displayName: "Pta",
        },
        supportRole: null,
        membershipAvailability: "complete",
        memberships: [
          {
            organisationId,
            organisationHandle: "nuki-inc",
            role: "owner",
            workspaces: [
              {
                workspaceId: "workspace_cafe_operations",
                workspaceHandle: "cafe-operations",
                name: "Cafe operations",
                createdAt: 1_800_000_000_000,
              },
            ],
          },
        ],
      },
    });
    return;
  }
  if (pathname === `/v1/control/organisations/${organisationId}`) {
    await route.fulfill({
      status: 200,
      json: {
        schema_version: 1,
        projection_revision: 1,
        configuration_version: 1,
        organisation: {
          organisation_id: organisationId,
          name: "Nuki Inc.",
          plan: "beta",
          lifecycle: {
            kind: "active",
            organisation_id: organisationId,
            activation_receipt_id: "receipt_production_acceptance",
            activated_at: 1_800_000_000_000,
            environment: "production",
          },
          capability_profile: "read_and_propose",
          created_at: 1_800_000_000_000,
        },
        steps: [
          {
            kind: "complete",
            step: "workspace",
            completed_at: 1_800_000_000_000,
            receipt_id: "receipt_workspace",
          },
          {
            kind: "complete",
            step: "commerce",
            completed_at: 1_800_000_000_001,
            receipt_id: "receipt_commerce",
          },
          {
            kind: "complete",
            step: "conversations",
            completed_at: 1_800_000_000_002,
            receipt_id: "receipt_conversations",
          },
          {
            kind: "complete",
            step: "operating_profile",
            completed_at: 1_800_000_000_003,
            receipt_id: "receipt_profile",
          },
          {
            kind: "complete",
            step: "review_activation",
            completed_at: 1_800_000_000_004,
            receipt_id: "receipt_activation",
          },
        ],
        provider_accounts: [],
        operating_profile: { kind: "unconfigured" },
        readiness: {
          kind: "ready",
          readiness_version: 1,
          readiness_hash: "readiness_production_acceptance",
        },
        activation: {
          kind: "succeeded",
          activation_attempt_id: "activation_attempt_production",
          activation_receipt_id: "activation_receipt_production",
          activated_at: 1_800_000_000_000,
        },
        next_action: {
          kind: "done",
          action_code: "onboarding_complete",
          label: "Onboarding complete",
        },
        first_task: null,
        support_reference: { kind: "none" },
        updated_at: 1_800_000_000_000,
      },
    });
    return;
  }
  if (
    pathname === `/v1/control/organisations/${organisationId}/inference/codex`
  ) {
    await route.fulfill({
      status: 200,
      json: { ok: true, connection: { kind: "disconnected", revision: 0 } },
    });
    return;
  }
  if (pathname.startsWith("/v1/control/user/preferences/")) {
    const area = pathname.slice("/v1/control/user/preferences/".length);
    const values =
      area === "appearance"
        ? { mode: "system", palette: "sage" }
        : area === "chat"
          ? { dockedPanelWidthPx: 600, fullscreenSidebarWidthPx: 360 }
          : {
              appearance: { kind: "inherit" },
              scene: { labels: "auto", minimap: false },
            };
    await route.fulfill({
      status: 200,
      json: {
        userId,
        area,
        schemaVersion: 1,
        revision: 1,
        updatedAt: 1_800_000_000_000,
        values,
      },
    });
    return;
  }
  if (
    pathname.endsWith("/commerce/entity-plane/resources") ||
    pathname.endsWith("/commerce/resources")
  ) {
    await route.fulfill({
      status: 200,
      json: { ok: true, entityTypes: [], relationshipDefinitions: [] },
    });
    return;
  }
  await route.fulfill({
    status: 200,
    json: { ok: true },
  });
}

verifyMorningShiftBrowser;
