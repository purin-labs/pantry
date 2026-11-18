// E2E browser verification for Kitchen workflow simulator Undo/Redo
// controls (Undo2 / Redo2 buttons and Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z / Ctrl+Y
// keyboard shortcuts) across appliance placement/rotation and customer order
// schedule / rush preset edits.
const undoRedoEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/simulator-undo-redo";

function readOvenState() {
  const raw = localStorage.getItem("satyr:floor-plan-workspace:v1");
  const parsed = raw ? JSON.parse(raw) : null;
  const activePlan = parsed?.activePlan ?? "reference";
  const pose = parsed?.placements?.[activePlan]?.bake ?? null;
  const envelope = document.querySelector(
    '.workflow-scene .spatial-check-envelope[data-envelope="bake"]',
  );
  return {
    activePlan,
    pose,
    envelope:
      envelope === null
        ? null
        : {
            x: Number(envelope.getAttribute("x")),
            y: Number(envelope.getAttribute("y")),
            width: Number(envelope.getAttribute("width")),
            height: Number(envelope.getAttribute("height")),
          },
  };
}

function near(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

async function verifySimulatorUndoRedoBrowser(page) {
  page.setDefaultTimeout(20000);
  const base =
    globalThis.bakeryBase ?? (await page.evaluate("location.origin"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/workflow-preview.html`);
  await page.evaluate(() => {
    localStorage.removeItem("satyr:floor-plan-workspace:v1");
  });
  await page.reload();

  const hasWebGL = await page.evaluate(
    'Boolean(document.createElement("canvas").getContext("webgl2"))',
  );

  const undoButton = page.getByRole("button", { name: "Undo", exact: true });
  const redoButton = page.getByRole("button", { name: "Redo", exact: true });

  await undoButton.waitFor({ state: "visible" });
  await redoButton.waitFor({ state: "visible" });

  if (!(await undoButton.isDisabled()) || !(await redoButton.isDisabled())) {
    throw new Error("Undo and Redo must start disabled on a clean session.");
  }

  // Open the 2D Floor plan dock so both 3D scene and 2D floor plan are active.
  await page.getByRole("button", { name: "Floor plan", exact: true }).click();
  const map = page.locator(
    '.workflow-scene [role="group"][aria-label="Equipment floor plan"]',
  );
  await map.waitFor({ state: "visible" });

  const oven = map.locator('button[data-resource="bake"]');
  await oven.waitFor({ state: "visible" });

  // Ensure initial pose is persisted and read baseline envelope + pose.
  const initial = await page.evaluate(readOvenState);
  if (initial.envelope === null) {
    throw new Error("Missing oven check envelope in floor plan.");
  }

  // 1. Rotate the oven 90° and verify Undo becomes enabled.
  await oven.click();
  await oven.press("r");

  const afterRotate = await page.evaluate(readOvenState);
  if (
    afterRotate.pose === null ||
    near(afterRotate.pose.rotY, initial.pose?.rotY ?? 0)
  ) {
    throw new Error(
      `Expected oven rotation to change rotY: ${JSON.stringify({ initial, afterRotate })}`,
    );
  }
  if (await undoButton.isDisabled()) {
    throw new Error("Undo button must be enabled after rotating oven.");
  }
  if (!(await redoButton.isDisabled())) {
    throw new Error("Redo button must remain disabled before undoing.");
  }
  const rotateUndoTitle = await undoButton.getAttribute("title");
  if (!rotateUndoTitle || !rotateUndoTitle.startsWith("Undo:")) {
    throw new Error(`Expected descriptive Undo title, got: ${rotateUndoTitle}`);
  }

  // 2. Drag the oven across the floor plan in multiple pointer move steps and
  // verify continuous drag coalesces into a single undo step.
  const markerBox = await oven.boundingBox();
  if (markerBox === null) {
    throw new Error("Oven floor-plan marker has no bounding box.");
  }
  const startX = markerBox.x + markerBox.width / 2;
  const startY = markerBox.y + markerBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 90, startY + 60, { steps: 10 });
  await page.mouse.up();

  const afterDrag = await page.evaluate(readOvenState);
  if (
    afterDrag.pose === null ||
    (near(afterDrag.pose.x, afterRotate.pose.x) &&
      near(afterDrag.pose.z, afterRotate.pose.z))
  ) {
    throw new Error(
      `Expected oven drag to move pose: ${JSON.stringify({ afterRotate, afterDrag })}`,
    );
  }
  const dragUndoTitle = await undoButton.getAttribute("title");
  if (dragUndoTitle !== "Undo: Move Baking") {
    throw new Error(
      `Expected Undo tooltip 'Undo: Move Baking', got: ${dragUndoTitle}`,
    );
  }
  const dragUndoDataTooltip = await undoButton.getAttribute("data-tooltip");
  if (
    !dragUndoDataTooltip ||
    !dragUndoDataTooltip.startsWith("Undo: Move Baking (")
  ) {
    throw new Error(
      `Expected shortcut-aware Undo data-tooltip, got: ${dragUndoDataTooltip}`,
    );
  }
  const undoBadge = undoButton.locator(".workflow-history-badge");
  await undoBadge.waitFor({ state: "visible" });
  const undoBadgeCount = await undoBadge.textContent();
  if (undoBadgeCount !== "2") {
    throw new Error(
      `Expected Undo step badge count '2' after rotate + drag, got: ${undoBadgeCount}`,
    );
  }
  await page.screenshot({ path: `${undoRedoEvidence}/01-after-move.png` });

  // 3. Click Undo button -> should revert the entire multi-step drag in ONE click
  // back to the post-rotation pose.
  await undoButton.click();
  const afterUndoDrag = await page.evaluate(readOvenState);
  if (
    afterUndoDrag.pose === null ||
    !near(afterUndoDrag.pose.x, afterRotate.pose.x) ||
    !near(afterUndoDrag.pose.z, afterRotate.pose.z) ||
    !near(afterUndoDrag.pose.rotY, afterRotate.pose.rotY)
  ) {
    throw new Error(
      `Undo did not revert coalesced drag in one step: ${JSON.stringify({ afterRotate, afterUndoDrag })}`,
    );
  }
  if (await redoButton.isDisabled()) {
    throw new Error("Redo button must be enabled after clicking Undo.");
  }
  const dragRedoTitle = await redoButton.getAttribute("title");
  if (dragRedoTitle !== "Redo: Move Baking") {
    throw new Error(
      `Expected Redo tooltip 'Redo: Move Baking', got: ${dragRedoTitle}`,
    );
  }
  const feedbackPill = page.locator(".workflow-history-feedback");
  await feedbackPill.waitFor({ state: "visible" });
  const feedbackText = await feedbackPill.textContent();
  if (feedbackText !== "Undone: Move Baking") {
    throw new Error(
      `Expected Undo feedback pill 'Undone: Move Baking', got: ${feedbackText}`,
    );
  }
  await page.screenshot({ path: `${undoRedoEvidence}/02-after-undo.png` });

  // 4. Click Redo button -> should reapply the moved oven pose.
  await redoButton.click();
  const afterRedoDrag = await page.evaluate(readOvenState);
  if (
    afterRedoDrag.pose === null ||
    !near(afterRedoDrag.pose.x, afterDrag.pose.x) ||
    !near(afterRedoDrag.pose.z, afterDrag.pose.z)
  ) {
    throw new Error(
      `Redo did not reapply moved oven pose: ${JSON.stringify({ afterDrag, afterRedoDrag })}`,
    );
  }
  if (!(await redoButton.isDisabled())) {
    throw new Error("Redo button must be disabled after reapplying latest step.");
  }
  await page.screenshot({ path: `${undoRedoEvidence}/03-after-redo.png` });

  // 5. Verify keyboard shortcuts (Ctrl+Z / Cmd+Z and Ctrl+Y / Cmd+Shift+Z).
  await page.keyboard.press("Control+z");
  const afterShortcutUndo = await page.evaluate(readOvenState);
  if (
    afterShortcutUndo.pose === null ||
    !near(afterShortcutUndo.pose.x, afterRotate.pose.x) ||
    !near(afterShortcutUndo.pose.z, afterRotate.pose.z)
  ) {
    throw new Error(
      `Ctrl+Z did not undo oven move: ${JSON.stringify({ afterRotate, afterShortcutUndo })}`,
    );
  }

  await page.keyboard.press("Control+Shift+Z");
  const afterShortcutRedo = await page.evaluate(readOvenState);
  if (
    afterShortcutRedo.pose === null ||
    !near(afterShortcutRedo.pose.x, afterDrag.pose.x) ||
    !near(afterShortcutRedo.pose.z, afterDrag.pose.z)
  ) {
    throw new Error(
      `Ctrl+Shift+Z did not redo oven move: ${JSON.stringify({ afterDrag, afterShortcutRedo })}`,
    );
  }

  // 6. Verify customer order / rush preset undo/redo AND input focus guard.
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page
    .locator("#workflow-dock-inspector")
    .getByRole("tab", { name: "Inputs", exact: true })
    .click();
  const weekendBtn = page
    .locator("#workflow-dock-inputs")
    .getByRole("button", { name: /Weekend/i })
    .first();
  await weekendBtn.waitFor({ state: "visible" });
  await weekendBtn.click();

  const presetUndoTitle = await undoButton.getAttribute("title");
  if (!presetUndoTitle || !presetUndoTitle.startsWith("Undo: Rush preset:")) {
    throw new Error(
      `Expected Rush preset undo title, got: ${presetUndoTitle}`,
    );
  }

  // Focus an <input> inside the Inputs dock and verify Ctrl+Z does NOT trigger simulator undo.
  const firstInput = page.locator("#workflow-field-batchCount");
  await firstInput.click();
  await page.keyboard.press("Control+z");
  const titleAfterInputCtrlZ = await undoButton.getAttribute("title");
  if (titleAfterInputCtrlZ !== presetUndoTitle) {
    throw new Error(
      `Ctrl+Z inside <input> should not trigger simulator undo; title changed from ${presetUndoTitle} to ${titleAfterInputCtrlZ}`,
    );
  }

  // Undo and Redo the rush preset via the toolbar buttons.
  await undoButton.click();
  const presetRedoTitle = await redoButton.getAttribute("title");
  if (presetRedoTitle !== presetUndoTitle.replace(/^Undo:/, "Redo:")) {
    throw new Error(
      `Expected Redo title after undoing preset, got: ${presetRedoTitle}`,
    );
  }
  await redoButton.click();

  // 7. Verify Edit history popover: range hover preview, multi-step Undo jump,
  // right-click open, and multi-step Redo jump.
  const historyTrigger = page.getByRole("button", {
    name: "Edit history",
    exact: true,
  });
  await historyTrigger.click();

  const popover = page.getByRole("dialog", {
    name: "Edit history",
    exact: true,
  });
  await popover.waitFor({ state: "visible" });

  const baselineRow = popover.locator(
    'button.workflow-history-entry[data-history-index="0"]',
  );
  const rotateRow = popover.locator(
    'button.workflow-history-entry[data-history-index="1"]',
  );
  const moveRow = popover.locator(
    'button.workflow-history-entry[data-history-index="2"]',
  );
  const presetRow = popover.locator(
    'button.workflow-history-entry[data-history-index="3"]',
  );

  if ((await presetRow.getAttribute("data-current")) !== "true") {
    throw new Error("Expected latest edit (index 3) to be marked current.");
  }

  await baselineRow.hover();
  const summaryEl = popover.locator(".workflow-history-popover-summary");
  const hoverUndoSummary = await summaryEl.textContent();
  if (hoverUndoSummary !== "Undo 3 steps") {
    throw new Error(
      `Expected hover summary 'Undo 3 steps' when pointing at baseline, got: ${hoverUndoSummary}`,
    );
  }
  if ((await moveRow.getAttribute("data-preview")) !== "undo") {
    throw new Error("Expected intermediate Move Baking row to preview 'undo'.");
  }
  await page.screenshot({ path: `${undoRedoEvidence}/04-history-popover.png` });

  // Jump back 2 steps in one click onto Rotate Baking (index 1).
  await rotateRow.click();
  await popover.waitFor({ state: "hidden" });

  const afterJumpUndo = await page.evaluate(readOvenState);
  if (
    afterJumpUndo.pose === null ||
    !near(afterJumpUndo.pose.x, afterRotate.pose.x) ||
    !near(afterJumpUndo.pose.z, afterRotate.pose.z) ||
    !near(afterJumpUndo.pose.rotY, afterRotate.pose.rotY)
  ) {
    throw new Error(
      `Multi-step popover jump did not land on Rotate Baking pose: ${JSON.stringify({ afterRotate, afterJumpUndo })}`,
    );
  }
  const jumpUndoFeedback = await feedbackPill.textContent();
  if (jumpUndoFeedback !== "Undone: 2 steps") {
    throw new Error(
      `Expected 'Undone: 2 steps' feedback pill, got: ${jumpUndoFeedback}`,
    );
  }

  // Right-click Undo button to reopen the popover and jump forward 2 Redo steps.
  await undoButton.click({ button: "right" });
  await popover.waitFor({ state: "visible" });

  const redoTopRow = popover.locator(
    'button.workflow-history-entry[data-history-index="3"]',
  );
  if ((await redoTopRow.getAttribute("data-role")) !== "redo") {
    throw new Error("Expected index 3 row to have role='redo' after jumping back.");
  }
  await redoTopRow.hover();
  const hoverRedoSummary = await summaryEl.textContent();
  if (hoverRedoSummary !== "Redo 2 steps") {
    throw new Error(
      `Expected hover summary 'Redo 2 steps', got: ${hoverRedoSummary}`,
    );
  }
  await page.screenshot({
    path: `${undoRedoEvidence}/05-history-popover-redo.png`,
  });

  await redoTopRow.click();
  await popover.waitFor({ state: "hidden" });

  const afterJumpRedo = await page.evaluate(readOvenState);
  if (
    afterJumpRedo.pose === null ||
    !near(afterJumpRedo.pose.x, afterDrag.pose.x) ||
    !near(afterJumpRedo.pose.z, afterDrag.pose.z)
  ) {
    throw new Error(
      `Multi-step Redo jump did not restore moved oven pose: ${JSON.stringify({ afterDrag, afterJumpRedo })}`,
    );
  }
  const jumpRedoFeedback = await feedbackPill.textContent();
  if (jumpRedoFeedback !== "Redone: 2 steps") {
    throw new Error(
      `Expected 'Redone: 2 steps' feedback pill, got: ${jumpRedoFeedback}`,
    );
  }

  // 8. Verify Clear history button resets Undo/Redo stacks while preserving current pose.
  await historyTrigger.click();
  await popover.waitFor({ state: "visible" });
  const clearBtn = popover.getByRole("button", {
    name: "Clear history",
    exact: true,
  });
  await clearBtn.waitFor({ state: "visible" });
  await clearBtn.hover();
  await page.screenshot({
    path: `${undoRedoEvidence}/06-history-popover-clear.png`,
  });
  await clearBtn.click();
  await popover.waitFor({ state: "hidden" });

  if (!(await undoButton.isDisabled()) || !(await redoButton.isDisabled())) {
    throw new Error(
      "Expected Undo and Redo buttons to disable after Clear history.",
    );
  }
  if (await historyTrigger.isDisabled()) {
    throw new Error(
      "Expected Edit history trigger to remain enabled while a custom layout is active.",
    );
  }
  const clearFeedback = await feedbackPill.textContent();
  if (clearFeedback !== "History cleared") {
    throw new Error(
      `Expected 'History cleared' feedback pill, got: ${clearFeedback}`,
    );
  }
  const afterClearPose = await page.evaluate(readOvenState);
  if (
    afterClearPose.pose === null ||
    !near(afterClearPose.pose.x, afterDrag.pose.x) ||
    !near(afterClearPose.pose.z, afterDrag.pose.z)
  ) {
    throw new Error(
      `Clear history should preserve current oven pose: ${JSON.stringify({ afterDrag, afterClearPose })}`,
    );
  }

  // 9. Re-open Floor plan and Edit history popover, then click Reset to initial layout
  // to restore default appliance poses and leave all history controls disabled.
  await page.getByRole("button", { name: "Floor plan", exact: true }).click();
  await map.waitFor({ state: "visible" });
  await historyTrigger.click();
  await popover.waitFor({ state: "visible" });

  if (!(await clearBtn.isDisabled())) {
    throw new Error(
      "Expected Clear history button inside popover to be disabled when stack is empty.",
    );
  }
  const resetLayoutBtn = popover.getByRole("button", {
    name: "Reset to initial layout",
    exact: true,
  });
  await resetLayoutBtn.waitFor({ state: "visible" });
  await resetLayoutBtn.hover();
  await page.screenshot({
    path: `${undoRedoEvidence}/07-history-popover-reset.png`,
  });
  await resetLayoutBtn.click();
  await popover.waitFor({ state: "hidden" });

  const resetFeedback = await feedbackPill.textContent();
  if (resetFeedback !== "Reset to initial layout") {
    throw new Error(
      `Expected 'Reset to initial layout' feedback pill, got: ${resetFeedback}`,
    );
  }
  if (
    !(await undoButton.isDisabled()) ||
    !(await redoButton.isDisabled()) ||
    !(await historyTrigger.isDisabled())
  ) {
    throw new Error(
      "Expected Undo, Redo, and Edit history trigger to disable after Reset to initial layout.",
    );
  }
  const afterReset = await page.evaluate(readOvenState);
  if (
    afterReset.pose !== null ||
    afterReset.envelope === null ||
    !near(afterReset.envelope.x, initial.envelope.x) ||
    !near(afterReset.envelope.y, initial.envelope.y) ||
    !near(afterReset.envelope.width, initial.envelope.width) ||
    !near(afterReset.envelope.height, initial.envelope.height)
  ) {
    throw new Error(
      `Reset to initial layout did not restore initial oven pose/envelope: ${JSON.stringify({ initial, afterReset })}`,
    );
  }

  return {
    result: "passed",
    status: "passed",
    hasWebGL,
    initialEnvelope: initial.envelope,
    afterRotatePose: afterRotate.pose,
    afterDragPose: afterDrag.pose,
    afterUndoPose: afterUndoDrag.pose,
    afterRedoPose: afterRedoDrag.pose,
    presetUndoTitle,
  };
}
