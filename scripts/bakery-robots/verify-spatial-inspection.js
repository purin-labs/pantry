async function verifySpatialInspection(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const lightTheme = page.getByRole("button", {
    name: "Use light sage theme",
    exact: true,
  });
  if (await lightTheme.isVisible()) await lightTheme.click();
  const sidebar = page.getByRole("button", {
    name: "Expand sidebar",
    exact: true,
  });
  if (await sidebar.isVisible()) await sidebar.click();
  const inspector = page.getByRole("button", {
    name: "Close Inspector",
    exact: true,
  });
  if (await inspector.isVisible()) await inspector.click();
  const toggle = page.locator("#workflow-toggle-floorPlan");
  const plan = page.locator(".workflow-scene .spatial-floor-plan");
  // Selection and fit details open over the plan from beside its scale bar.
  const selectionPanel = plan.locator(".spatial-plan-details");
  const planDetails = plan.getByRole("button", {
    name: "Layout and fit",
    exact: true,
  });
  await toggle.click();
  const room = plan.getByRole("img", { name: /^Assumed room: 11 by 7 metres/ });
  await room.waitFor();
  await plan.getByText("11 m", { exact: true }).waitFor();
  await plan.getByText("7 m", { exact: true }).waitFor();
  await plan.getByText("Rear wall", { exact: true }).waitFor();
  const roomBefore = await room.boundingBox();
  if (
    roomBefore === null ||
    Math.abs(roomBefore.width / roomBefore.height - 11 / 7) > 0.01
  )
    throw new Error("The room must preserve its modeled 11 × 7 m proportions.");
  const cooling = plan.getByRole("button", { name: "Cooling", exact: true });
  await cooling.focus();
  await page.keyboard.press("Enter");
  if (
    (await cooling.getAttribute("aria-pressed")) !== "true" ||
    (await inspector.isVisible())
  )
    throw new Error(
      "Plan selection must stay linked without opening another inspector.",
    );
  await planDetails.click();
  await selectionPanel
    .locator(".spatial-dimensions")
    .filter({ hasText: "Cooling:" })
    .waitFor();
  await planDetails.click();
  await page.screenshot({
    path: "output/playwright/plan42d-pane-selection.png",
  });

  await plan.getByRole("button", { name: "Packing", exact: true }).click();
  await planDetails.click();
  await selectionPanel
    .locator(".spatial-dimensions")
    .filter({ hasText: "Packing:" })
    .waitFor();
  await planDetails.click();
  const viewport = page.locator(".workflow-scene .spatial-scene-viewport");
  const before = await plan.boundingBox();
  const sceneBefore = await viewport.boundingBox();
  const workstation = await page.locator(".workflow-scene").boundingBox();
  const drawing = await plan.locator(".spatial-plan-drawing").boundingBox();
  if (
    before === null ||
    sceneBefore === null ||
    before.x + before.width > sceneBefore.x
  )
    throw new Error("The plan must occupy separate space beside 3D.");
  if (
    workstation === null ||
    before.x !== workstation.x ||
    before.y !== workstation.y ||
    before.height !== workstation.height ||
    sceneBefore.y !== workstation.y ||
    sceneBefore.height !== workstation.height
  )
    throw new Error(
      "Both panes must fill the workstation beneath floating controls.",
    );
  if (
    drawing === null ||
    drawing.width <= 0 ||
    drawing.height <= 0 ||
    drawing.width > before.width ||
    drawing.x < before.x
  )
    throw new Error("The dimensioned drawing must fit inside its pane.");
  await planDetails.click();
  const expandedDrawing = await plan
    .locator(".spatial-plan-drawing")
    .boundingBox();
  if (
    expandedDrawing?.height !== drawing.height ||
    expandedDrawing?.width !== drawing.width
  )
    throw new Error("Opening inspection details must not shrink the drawing.");
  await planDetails.click();
  const divider = page.getByRole("separator", { name: "Floor plan width" });
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  const keyboardWidth = Number(await divider.getAttribute("aria-valuenow"));
  if (keyboardWidth !== before.width + 24)
    throw new Error("Arrow keys must resize the pane.");
  const grip = await divider.boundingBox();
  if (grip === null) throw new Error("Missing resize divider.");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2 + 70,
    grip.y + grip.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  const after = await plan.boundingBox();
  const sceneAfter = await viewport.boundingBox();
  const roomAfter = await room.boundingBox();
  if (
    roomAfter === null ||
    roomAfter.width <= roomBefore.width ||
    Math.abs(roomAfter.width / roomAfter.height - 11 / 7) > 0.01
  )
    throw new Error(
      "Resizing must scale the room uniformly with the equipment.",
    );
  if (
    after === null ||
    sceneAfter === null ||
    after.width !== keyboardWidth + 70 ||
    sceneAfter.width >= sceneBefore.width
  )
    throw new Error("Dragging the divider must resize both panes.");
  await page.screenshot({ path: "output/playwright/plan42d-pane-resized.png" });
  await toggle.click();
  if ((await toggle.getAttribute("aria-expanded")) !== "false")
    throw new Error("Closing must update the toolbar toggle.");
  await page.keyboard.press("Enter");
  await planDetails.click();
  await selectionPanel
    .locator(".spatial-dimensions")
    .filter({ hasText: "Packing:" })
    .waitFor();
  await planDetails.click();

  await openRecordingViewer(page);
  const filesTab = page.getByRole("tab", {
    name: "Compare & files",
    exact: true,
  });
  if (!(await filesTab.isVisible()))
    await page
      .getByRole("button", { name: "Setup & files", exact: true })
      .click();
  await filesTab.click();
  const file = page.getByLabel("Recording file (.json)");
  await file.setInputFiles("output/playwright/plan42d-blocked-recording.json");
  await page
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  const rehearsal = page.locator(".physics-replay");
  const nativePlan = rehearsal.locator(".spatial-floor-plan");
  // Fit findings, dimensions and camera views show in the selection and
  // fit panel beside the drawing.
  const nativeInspector = rehearsal.locator(".spatial-selection-inspector");
  await rehearsal
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  const finding = nativeInspector.getByRole("button", {
    name: "Recorded fit failure: Rack slot is blocked by the destination obstruction.",
    exact: true,
  });
  await finding.click();
  await nativePlan
    .getByRole("img", { name: /^Assumed room: 11 by 7 metres/ })
    .waitFor();
  if (
    (await nativePlan
      .locator(".spatial-floor-map button[data-fit=blocked]")
      .count()) !== 2
  )
    throw new Error("The rack and obstruction must both be marked blocked.");
  await page.screenshot({ path: "output/playwright/plan42d-pane-blocked.png" });

  const recordedDimensions = nativeInspector.locator(".spatial-dimensions p");
  if ((await recordedDimensions.count()) !== 2)
    throw new Error("Both inspected resources must show their dimensions.");
  const recordingPosition = rehearsal.getByRole("slider", {
    name: "Recording position",
  });
  const timeBeforeViews = await recordingPosition.inputValue();
  const nativeViewport = rehearsal.locator(".spatial-scene-viewport");
  // Compare the rendered scene only; the details panel overlays the viewport.
  const sceneOnly = {
    style: ".spatial-inspection-panel { visibility: hidden !important; }",
  };
  await nativeInspector
    .getByRole("button", { name: "Top view", exact: true })
    .click();
  const topImage = await nativeViewport.screenshot(sceneOnly);
  await page.screenshot({ path: "output/playwright/plan42d-camera-top.png" });
  await nativeInspector
    .getByRole("button", { name: "Operator height · 1.6 m", exact: true })
    .click();
  const operatorImage = await nativeViewport.screenshot(sceneOnly);
  if (topImage.equals(operatorImage))
    throw new Error("Camera presets must change the rendered viewpoint.");
  if (
    (await recordingPosition.inputValue()) !== timeBeforeViews ||
    (await nativePlan
      .locator(".spatial-floor-map button[aria-pressed=true]")
      .count()) !== 2
  )
    throw new Error(
      "Camera presets must preserve recording time and the inspected pair.",
    );
  await page.screenshot({
    path: "output/playwright/plan42d-camera-operator.png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('.console-sidebar[data-mode="drawer"]')
    .waitFor({ state: "attached" });
  const collapseSidebar = page.getByRole("button", {
    name: "Collapse sidebar",
    exact: true,
  });
  if (await collapseSidebar.isVisible()) await collapseSidebar.click();
  if (await nativeViewport.isVisible())
    throw new Error("Narrow Plan view must hide 3D.");
  if (
    (await rehearsal.locator(".physics-header").isVisible()) ||
    (await rehearsal.locator(".physics-controls").isVisible())
  )
    throw new Error("Mobile Plan must dedicate the workspace to the drawing.");
  await page.screenshot({
    path: "output/playwright/plan42d-pane-mobile.png",
    animations: "disabled",
  });
  await rehearsal.getByRole("button", { name: "3D view", exact: true }).click();
  if ((await nativePlan.isVisible()) || !(await nativeViewport.isVisible()))
    throw new Error("The 3D switch must swap views.");
  if (!(await rehearsal.locator(".physics-controls").isVisible()))
    throw new Error("Switching to 3D must restore playback controls.");
  await rehearsal
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  if (
    (await nativePlan
      .locator(".spatial-floor-map button[aria-pressed=true]")
      .count()) !== 2
  )
    throw new Error("Switching views must preserve the inspected pair.");
  // On a narrow screen the details panel accompanies the 3D view.
  await rehearsal.getByRole("button", { name: "3D view", exact: true }).click();
  await nativeInspector
    .getByRole("button", { name: "Focus selection", exact: true })
    .click();
  if (!(await nativeViewport.isVisible()))
    throw new Error("Focus selection must show 3D on mobile.");
  await rehearsal
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  await nativePlan
    .getByRole("button", { name: "Zoom in", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  if (!(await nativePlan.isVisible()))
    throw new Error("Escape must return focus to the plan toggle.");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  await file.setInputFiles(
    "apps/portal/src/features/workflow-simulator/fixtures/physics-recording-v2.json",
  );
  await page
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  if (!(await nativePlan.isVisible()))
    await rehearsal
      .getByRole("button", { name: "Floor plan", exact: true })
      .click();
  await nativeInspector
    .getByText("No confirmed conflicts · Checks limited", { exact: true })
    .waitFor();
  if (
    (await nativePlan
      .locator(".spatial-floor-map button[data-fit=blocked]")
      .count()) !== 0
  )
    throw new Error("Replacing a recording retained stale warnings.");
  const rack = nativePlan.getByRole("button", {
    name: "Rack slot",
    exact: true,
  });
  await rack.focus();
  await page.keyboard.press("Enter");
  await recordingPosition.focus();
  await page.keyboard.press("End");
  const endTime = await recordingPosition.inputValue();
  if (Number(endTime) <= 0)
    throw new Error("The nominal recording must have motion.");
  await nativeInspector
    .getByRole("button", { name: "Top view", exact: true })
    .click();
  const cameraImageStyle =
    ".physics-header, .physics-controls, .portal-workspace-header, .spatial-inspection-panel { visibility: hidden !important; }";
  const beforeOrbit = await nativeViewport.screenshot({
    style: cameraImageStyle,
  });
  const nativeBounds = await nativeViewport.boundingBox();
  if (nativeBounds === null) throw new Error("Missing native viewport.");
  const orbitX = nativeBounds.x + nativeBounds.width / 2;
  const orbitY = nativeBounds.y + nativeBounds.height * 0.6;
  await page.mouse.move(orbitX, orbitY);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(orbitX + 80, orbitY + 80, { steps: 5 });
  await page.mouse.up({ button: "right" });
  const manualOrbit = await nativeViewport.screenshot({
    path: "output/playwright/plan42d-manual-before-selection.png",
    style: cameraImageStyle,
  });
  if (beforeOrbit.equals(manualOrbit))
    throw new Error("Manual orbit must remain available after a preset.");
  await rack.focus();
  await page.keyboard.press("Enter");
  const afterSelection = await nativeViewport.screenshot({
    path: "output/playwright/plan42d-manual-after-selection.png",
    style: cameraImageStyle,
  });
  if (
    !manualOrbit.equals(afterSelection) ||
    (await recordingPosition.inputValue()) !== endTime
  )
    throw new Error(
      "Reselecting equipment must preserve manual camera and recording time.",
    );
  await page.screenshot({
    path: "output/playwright/plan42d-camera-manual.png",
  });
  await page
    .getByRole("button", { name: "Back to production", exact: true })
    .click();
  if ((await page.locator(".spatial-workspace:visible").count()) !== 1)
    throw new Error("Leaving rehearsal retained a duplicate workspace.");
  return {
    result: "passed",
    linkedSelection: true,
    separateViewports: true,
    dockedBelowFloatingControls: true,
    drawingFitsPane: true,
    dimensionedRoomAndWall: true,
    dimensionSourcesVisible: true,
    cameraPresetsPreserveTimeAndSelection: true,
    manualOrbitSurvivesSelection: true,
    keyboardResizePixels: 24,
    pointerResizePixels: 70,
    mobileViewSwitchPreservesSelection: true,
    focusShows3D: true,
    escapeRestoresToggleFocus: true,
    recordingReplacementClearsWarnings: true,
    sceneExitClean: true,
  };
}
