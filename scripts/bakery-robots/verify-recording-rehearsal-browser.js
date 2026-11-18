// Plan 42F F1d: the recording viewer opens examples and files, and a recording
// becomes a rehearsal tray on the production scheduler. Saved runs open from
// Multi-tray rehearsal. Run with the Playwright CLI.
const recordingEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan42f-f1d-recording-viewer";

async function verifyRecordingRehearsalBrowser(page) {
  page.setDefaultTimeout(15000);
  const base =
    globalThis.bakeryBase ?? (await page.evaluate("location.origin"));
  await page.goto(`${base}/workflow-preview.html`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecordingViewer(page);
  const viewer = page.locator(".physics-replay");
  for (const removed of ["Workflow", "Timeline", "Details", "New run"])
    if (
      (await viewer
        .getByRole("button", { name: removed, exact: true })
        .count()) !== 0
    )
      throw new Error(`The recording viewer still offers ${removed}.`);

  // Escape closes the setup panel before leaving the viewer.
  const setup = viewer.locator("#physics-setup");
  await setup.waitFor();
  await viewer.getByRole("heading", { name: "Robot rehearsal" }).focus();
  await page.keyboard.press("Escape");
  await setup.waitFor({ state: "hidden" });
  await viewer
    .getByRole("button", { name: "Setup & files", exact: true })
    .click();
  await setup.waitFor();

  // A saved run is redirected to Multi-tray rehearsal. The rehearsal file
  // is the run saved by verify-tray-layout-drag-browser.js.
  await viewer
    .getByRole("tab", { name: "Compare & files", exact: true })
    .click();
  await viewer
    .getByLabel("Recording file (.json)")
    .setInputFiles("output/playwright/plan42f-tray-layout-drag/applied.json");
  await viewer
    .locator("#physics-import-error")
    .filter({ hasText: "Open it from Multi-tray rehearsal" })
    .waitFor();

  // The rack cycle recording becomes tray A with every result accepted.
  await viewer.getByRole("button", { name: /^Oven → table → rack/ }).click();
  const rehearse = viewer.getByRole("button", {
    name: "Rehearse this recording",
    exact: true,
  });
  await rehearse.waitFor();
  await page.screenshot({ path: `${recordingEvidence}/viewer.png` });
  await rehearse.click();
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "Tray A opened from the recording" })
    .waitFor({ timeout: 30000 });
  await page
    .locator(".production-browser-run p")
    .filter({ hasText: "Every native operation has a result" })
    .waitFor();
  await editInputs(page);
  const legends = await page
    .locator(".production-panel fieldset legend")
    .allTextContents();
  if (!legends.some((text) => text.startsWith("Tray A")))
    throw new Error(`Tray A is missing: ${legends.join(", ")}`);
  await page.screenshot({ path: `${recordingEvidence}/rehearsal.png` });
  await backToExamples(page);
  // The viewer keeps the recording it rehearsed.
  await rehearse.waitFor();
  return {
    status: "passed",
    legends,
    checks: [
      "the viewer offers no single-rehearsal panels or New run",
      "Escape closes the setup panel",
      "a saved rehearsal run is redirected to Multi-tray rehearsal",
      "Rehearse this recording opens tray A with its results accepted",
      "Back to examples returns to the viewer with the recording open",
    ],
  };
}
