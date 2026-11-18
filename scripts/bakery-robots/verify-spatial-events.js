async function verifySpatialEvents(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await openRecordingViewer(page);
  const setup = page.getByRole("button", {
    name: "Setup & files",
    exact: true,
  });
  const filesTab = page.getByRole("tab", {
    name: "Compare & files",
    exact: true,
  });
  if (!(await filesTab.isVisible())) await setup.click();
  await filesTab.click();
  const file = page.getByLabel("Recording file (.json)");
  await file.setInputFiles("output/playwright/plan42d-blocked-recording.json");
  await setup.click();
  const rehearsal = page.locator(".physics-replay");
  if (!(await rehearsal.locator(".spatial-floor-plan").isVisible())) {
    await rehearsal
      .getByRole("button", { name: "Floor plan", exact: true })
      .click();
  }
  const plan = rehearsal.locator(".spatial-floor-plan");
  // Fit findings, door inspection and camera views show in the selection
  // and fit panel beside the drawing.
  const details = rehearsal.locator(".spatial-selection-inspector");
  const position = rehearsal.getByRole("slider", {
    name: "Recording position",
  });
  const finding = details.getByRole("button", {
    name: /^Recorded fit failure:/,
  });
  const title = await finding.getAttribute("title");
  await finding.click();
  const eventTime = Number(await position.inputValue());
  if (
    !Number.isFinite(eventTime) ||
    title !== `Inspect recorded failure at ${eventTime.toFixed(2)} s`
  )
    throw new Error(
      "Recorded fit inspection must identify and seek the exact failure event.",
    );
  if (
    (await plan
      .locator('.spatial-floor-map button[aria-pressed="true"]')
      .count()) !== 2
  )
    throw new Error(
      "Recorded fit inspection must frame both affected resources.",
    );
  await page.screenshot({
    path: "output/playwright/plan42d-recorded-event.png",
  });

  await setup.click();
  await file.setInputFiles(
    "assets/bakery-mujoco/fr10-workcell/recordings/oven-loading.json",
  );
  await setup.click();
  if (!(await rehearsal.locator(".spatial-floor-plan").isVisible())) {
    await rehearsal
      .getByRole("button", { name: "Floor plan", exact: true })
      .click();
  }
  await details.getByText("Inspect oven door", { exact: true }).click();
  const opening = details.getByText(/^Full 0–110° opening:/);
  await opening.waitFor();
  const openingStatus = await opening.innerText();
  if (/0 of 0/.test(openingStatus))
    throw new Error("Door sweep did not check fixed equipment.");
  await plan.locator(".spatial-opening-envelope:not([hidden])").waitFor();
  const angle = details.getByRole("slider", {
    name: "Preview door angle (degrees)",
  });
  const recordedAngle = await angle.inputValue();
  const timeBefore = await position.inputValue();
  const viewport = rehearsal.locator(".spatial-scene-viewport");
  await details.getByRole("button", { name: "Top view", exact: true }).click();
  // Compare the rendered scene only; the details panel overlays the viewport.
  const screenshotStyle =
    ".physics-header, .physics-controls, .portal-workspace-header, .spatial-inspection-panel { visibility: hidden !important; }";
  await page.mouse.move(10, 10);
  const footprint = plan.locator(
    '.spatial-floor-map button[data-resource="maruzen-shelf-3"]',
  );
  const recordedBounds = await footprint.getAttribute("style");
  const before = await viewport.screenshot({
    style: screenshotStyle,
    path: "output/playwright/plan42d-door-before-viewport.png",
  });
  await angle.focus();
  await page.keyboard.press("Home");
  await page.mouse.move(10, 10);
  await details
    .getByText("Door preview · 0° · Playback paused", { exact: true })
    .waitFor();
  const preview = await viewport.screenshot({ style: screenshotStyle });
  if (before.equals(preview))
    throw new Error("Door preview must change the displayed geometry.");
  if ((await position.inputValue()) !== timeBefore)
    throw new Error("Door preview changed the recording cursor.");
  await page.screenshot({ path: "output/playwright/plan42d-door-preview.png" });
  await details
    .getByRole("button", { name: "Return to recorded door pose" })
    .click();
  await page.mouse.move(10, 10);
  const restored = await viewport.screenshot({
    style: screenshotStyle,
    path: "output/playwright/plan42d-door-restored-viewport.png",
  });
  if (
    (await angle.inputValue()) !== recordedAngle ||
    (await footprint.getAttribute("style")) !== recordedBounds
  )
    throw new Error(
      "Leaving door preview must restore the recorded angle and occupied footprint.",
    );
  await page.screenshot({
    path: "output/playwright/plan42d-door-restored.png",
  });
  await rehearsal
    .getByRole("button", { name: "Play recording", exact: true })
    .click();
  await page.waitForFunction(
    "Number(document.querySelector('.physics-replay .physics-scrubber input')?.value) > 0",
  );
  await angle.focus();
  await page.keyboard.press("Home");
  await rehearsal
    .getByRole("button", { name: "Play recording", exact: true })
    .waitFor();
  const pausedTime = await position.inputValue();
  await page.waitForTimeout(200);
  if ((await position.inputValue()) !== pausedTime)
    throw new Error("Door inspection did not pause running playback.");
  await details.getByText("Inspect oven door", { exact: true }).click();
  await details
    .getByText("Recorded door pose restored.", { exact: true })
    .waitFor({ state: "attached" });
  if ((await footprint.getAttribute("style")) !== recordedBounds)
    throw new Error("Closing door inspection retained the preview geometry.");
  await page.evaluate(
    "document.querySelector('.physics-replay .spatial-scene-viewport canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()",
  );
  await rehearsal
    .locator(".physics-floor-plan-only .spatial-floor-plan")
    .waitFor();
  await plan.getByRole("button", { name: "Source table", exact: true }).focus();
  await page.keyboard.press("Enter");
  await details.locator(".spatial-dimensions p").first().waitFor();
  if ((await position.inputValue()) !== pausedTime)
    throw new Error("WebGL fallback changed playback time.");
  await details.getByText("Inspect oven door", { exact: true }).click();
  await details.getByText(openingStatus, { exact: true }).waitFor();
  await angle.focus();
  await page.keyboard.press("Home");
  await details
    .getByText("Door preview · 0° · Playback paused", { exact: true })
    .waitFor();
  await details
    .getByRole("button", { name: "Return to recorded door pose" })
    .click();
  await page.screenshot({
    path: "output/playwright/plan42d-webgl-fallback.png",
  });
  return {
    result: "passed",
    recordedEventTime: eventTime,
    pairedFindingSelection: true,
    doorPreviewChangesGeometry: true,
    doorPreviewPreservesCursor: true,
    recordedFootprintRestored: true,
    playbackPausedForInspection: true,
    collapsedInspectionRestoresPose: true,
    webglFallbackPreservesCursor: true,
    doorSweepStatus: openingStatus,
    noWebGLDoorInspection: true,
    restoredImageByteIdentical: before.equals(restored),
  };
}
