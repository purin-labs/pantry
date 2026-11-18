// Shared scheduler → Wasm loading/retrieval/racking → saved run → Three.js playback.
const rackEvidence = "output/playwright/ur5e-ingredients-workflow-verified";
const rackPlan =
  "output/bakery-robots/ur5e-ingredients-scheduler-final/before-loading.json";

async function openRackRun(page, file) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByLabel("Open production run or native recording", { exact: true })
    .setInputFiles(file);
  await page
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  await page
    .locator(".production-panel .production-notice")
    .filter({ hasText: "Saved rehearsal reopened paused" })
    .waitFor();
}
async function saveRackRun(page, name) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save production run", exact: true })
    .click();
  const download = await pending;
  await download.saveAs(`${rackEvidence}/${name}.json`);
}
async function verifyUr5eRackBrowser(page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openRobotRehearsal(page);
  await editInputs(page);
  const assignments = await page
    .getByLabel("Workcell robot assignments", { exact: true })
    .innerText();
  if (!assignments.includes("FANUC") || !assignments.includes("FAIRINO FR10"))
    throw new Error(
      "The two-tray preset must retain both arms in separate cells",
    );
  await openRackRun(page, rackPlan);
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await page
    .locator(".production-browser-run p")
    .filter({ hasText: "Browser run complete." })
    .waitFor({ timeout: 300000 });
  await saveRackRun(page, "completed");
  await openRackRun(page, `${rackEvidence}/completed.json`);
  await saveRackRun(page, "restored");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.getByRole("slider", { name: "Production time" }).press("End");
  await page.screenshot({ path: `${rackEvidence}/completed-workflow.png` });
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.screenshot({ path: `${rackEvidence}/completed-timeline.png` });
  return {
    status: "passed",
    checks: [
      "UR5e full chain executes in browser Wasm",
      "completed run reopens",
      "workflow and timeline show completed run",
    ],
  };
}
