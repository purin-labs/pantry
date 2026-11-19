// Shared scheduler → Wasm loading/retrieval/racking → saved run → Three.js playback.
// The plan is the UR5e chain that authored-continuation saved before loading;
// the row opens the page with ?evidence=/@fs/<authored-continuation>.
const rackEvidence = globalThis.bakeryEvidence;

async function verifyUr5eRackBrowser(page) {
  const rackPlan = `${new URL(page.url()).searchParams
    .get("evidence")
    .replace(/^\/@fs/u, "")}/before-loading.json`;
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
  await saveRackRun(page, rackEvidence, "completed");
  await openRackRun(page, `${rackEvidence}/completed.json`);
  await saveRackRun(page, rackEvidence, "restored");
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
