async function verifyDeviceBrowser(page) {
  const results = [];
  const userAgent = await page.evaluate("navigator.userAgent");
  const engine = userAgent.includes("Chrome") ? "chromium" : "webkit";
  const hasWebGL = await page.evaluate(
    "Boolean(document.createElement('canvas').getContext('webgl2'))",
  );
  const label = `${engine}-${hasWebGL ? "webgl" : "fallback"}`;
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const navigationStart = Date.now();
    await page.reload();
    await page
      .getByRole("button", { name: "Play shift", exact: true })
      .waitFor();
    const readyMs = Date.now() - navigationStart;
    const sidebar = page.getByRole("button", {
      name: "Collapse sidebar",
      exact: true,
    });
    if (await sidebar.isVisible()) await sidebar.click();
    const inputs = page.getByRole("button", { name: "Inputs", exact: true });
    if ((await inputs.getAttribute("aria-expanded")) !== "true")
      await inputs.click();
    await openScenarios(page);
    await page
      .getByLabel("Import measured shift JSON", { exact: true })
      .setInputFiles(
        "apps/portal/src/features/workflow-simulator/fixtures/measured-shift-unequal-cycles.json",
      );
    await page
      .getByRole("cell", { name: "20 min (10 min–30 min)", exact: true })
      .waitFor();
    const initialFinish = await page.getByText(/^Finish ~/).innerText();
    await page
      .getByRole("button", {
        name: "Put suggested values in draft",
        exact: true,
      })
      .click();
    await inputs.click();
    if (
      (await page
        .getByRole("spinbutton", { name: "Bake time (min)", exact: true })
        .inputValue()) !== "20"
    )
      throw new Error("Shared oven cycles were weighted by batches");
    if ((await page.getByText(/^Finish ~/).innerText()) !== initialFinish)
      throw new Error("Staging observations changed the applied run");
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    const appliedFinish = await page.getByText(/^Finish ~/).innerText();
    if (appliedFinish === initialFinish)
      throw new Error("Applying observations did not rerun the shift");
    await page
      .getByText("Local demo · Assumed timings", { exact: true })
      .waitFor({ state: "attached" });
    await openScenarios(page);
    await page
      .getByLabel("Import measured shift JSON", { exact: true })
      .setInputFiles(
        "output/playwright/plan42-host-device/malformed-observations.json",
      );
    await page.getByRole("alert").waitFor();
    if ((await page.getByText(/^Finish ~/).innerText()) !== appliedFinish)
      throw new Error("Malformed observations replaced the applied run");
    await page.screenshot({
      path: `output/playwright/plan42-host-device/${label}-${viewport.width}-intake.png`,
    });
    await page
      .getByRole("button", { name: "Close Scenarios", exact: true })
      .click();
    const interactionStart = Date.now();
    const seek = page.getByRole("slider", {
      name: "Seek through the shift",
      exact: true,
    });
    if (await seek.isVisible())
      await page
        .getByRole("button", { name: "Production timeline", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Production timeline", exact: true })
      .click();
    await seek.waitFor();
    const timelineMs = Date.now() - interactionStart;
    await seek.focus();
    await page.keyboard.press("End");
    const end = await seek.inputValue();
    const maximum = await seek.getAttribute("max");
    if (Number(end) !== Number(maximum))
      throw new Error("Keyboard End did not reach the end of the shift");
    await page.keyboard.press("Home");
    await page.getByRole("button", { name: "Play shift", exact: true }).click();
    const frames = await page.evaluate(`{
      const result = Promise.withResolvers();
      const intervals = [];
      let previous = null;
      function frame(time) {
        if (previous !== null) intervals.push(time - previous);
        previous = time;
        if (intervals.length < 180) requestAnimationFrame(frame);
        else result.resolve(intervals);
      }
      requestAnimationFrame(frame);
      result.promise;
    }`);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const width = await page.evaluate(
      "({viewport: innerWidth, document: document.documentElement.scrollWidth})",
    );
    if (width.document > width.viewport)
      throw new Error(`Horizontal document overflow at ${viewport.width}px`);
    await page.screenshot({
      path: `output/playwright/plan42-host-device/${label}-${viewport.width}-playback.png`,
    });
    const sorted = Float64Array.from(frames).sort();
    let above50 = 0;
    for (const interval of frames) if (interval > 50) above50++;
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    results.push({
      viewport,
      readyMs,
      timelineMs,
      frameP95Ms: p95,
      frameMaxMs: sorted.at(-1),
      framesAbove50Ms: above50,
      localPerformanceGate: timelineMs < 100 && p95 < 33.4 && above50 === 0,
      width,
      initialFinish,
      appliedFinish,
      sharedCycleMedianMinutes: 20,
      draftPreservedRun: true,
      malformedPreservedRun: true,
      assumedTimingsRetained: true,
      keyboardEnd: end,
    });
  }
  return {
    userAgent,
    hasWebGL,
    scenario: "Synthetic four-batch intake and shift playback",
    physicalDevice: false,
    results,
  };
}
