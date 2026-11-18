// Plan 42F F1b: rehearsal tray chains run loading → retrieval → racking in
// browser MuJoCo on the production scheduler. Run with the Playwright CLI.
const rehearsalBase = globalThis.bakeryBase ?? "http://127.0.0.1:5188";
const rehearsalEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan42f-rehearsal-browser";

function rehearsalNotice(page, text) {
  return page
    .locator(".production-panel .production-notice")
    .filter({ hasText: text })
    .waitFor({ timeout: 30000 });
}
function rehearsalStatus(page, text, timeout = 180000) {
  return page
    .locator(".production-browser-run p")
    .filter({ hasText: text })
    .waitFor({ timeout });
}
function tray(page, batchId) {
  return page.locator(".production-panel fieldset", {
    has: page.locator("legend", { hasText: new RegExp(`^Tray ${batchId} ·`) }),
  });
}
async function openRehearsal(page) {
  await page.goto(`${rehearsalBase}/workflow-preview.html`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRobotRehearsal(page);
  await rehearsalNotice(page, "Rehearsal prepared with two recorded trays.");
}
async function addChain(page, rackCase, batchId) {
  await chooseOption(
    page,
    page.locator(".production-rehearsal-add .pantry-select-trigger"),
    { value: rackCase },
  );
  await page
    .getByRole("button", { name: "Add browser tray chain", exact: true })
    .click();
  await tray(page, batchId).waitFor();
}
function isOpen(details) {
  return details.open;
}
// The checkbox mirrors the applied plan, so wait for the edit's notice.
async function prerequisite(page, batchId, label) {
  const fieldset = tray(page, batchId);
  if (!(await fieldset.locator("details").evaluate(isOpen)))
    await fieldset.locator("summary").click();
  await fieldset.getByLabel(label, { exact: true }).click();
}
async function saveRehearsal(page, name) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Save production run", exact: true })
      .click(),
  ]);
  await download.saveAs(`${rehearsalEvidence}/${name}.json`);
}
async function reopenRehearsal(page, name) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByLabel("Open production run or native recording", { exact: true })
    .setInputFiles(`${rehearsalEvidence}/${name}.json`);
  await page
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  await rehearsalNotice(page, "Saved rehearsal reopened paused");
}
function runButton(page) {
  return page.getByRole("button", { name: "Run in browser", exact: true });
}

async function verifyRehearsalBrowser(page) {
  await openRehearsal(page);
  await editInputs(page);
  await addChain(page, "nominal", "C");
  await addChain(page, "slip", "D");
  await addChain(page, "nominal", "E");
  // E joins both branches: it stages only after C and D finish racking.
  await prerequisite(page, "E", "Tray C · step 3 (Racking)");
  await rehearsalNotice(page, "Tray E prerequisites changed.");
  await prerequisite(page, "E", "Tray D · step 3 (Racking (slip))");
  await rehearsalNotice(page, "Tray E prerequisites changed.");
  // A cycle between trays is rejected and leaves the plan unchanged.
  await prerequisite(page, "C", "Tray E · step 1 (Loading)");
  await rehearsalNotice(
    page,
    "Choose prerequisites without a cycle between trays.",
  );
  const retrieval = tray(page, "D").getByLabel(
    "Step 2 · Retrieval earliest start (s)",
  );
  await retrieval.fill("700");
  await retrieval.press("Tab");
  await rehearsalNotice(page, "Start constraint changed.");
  await saveRehearsal(page, "authored");

  // Stop after C's loading, save, reopen and continue from its saved handoff.
  const gate = new WorkerFetchGate(2);
  await page.route(
    "**/bakery-physics/bundles/*/bakery_native.wasm",
    gate.handle.bind(gate),
  );
  await runButton(page).click();
  await gate.blocked;
  await page
    .getByRole("button", { name: "Stop simulation", exact: true })
    .click();
  gate.release();
  await page.unroute("**/bakery-physics/bundles/*/bakery_native.wasm");
  await rehearsalStatus(page, "Browser simulation stopped.");
  await saveRehearsal(page, "stopped");
  await reopenRehearsal(page, "stopped");
  await runButton(page).click();
  // D's injected slip holds the cell; E's join never stages.
  await rehearsalStatus(page, "failed. Its tray and the cell remain held");
  await saveRehearsal(page, "final");
  await reopenRehearsal(page, "final");
  await rehearsalStatus(
    page,
    "failed. Its tray and the cell remain held",
    10000,
  );
  if (!(await runButton(page).isDisabled()))
    throw new Error("A held rehearsal must not execute past its failure.");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.getByRole("slider", { name: "Production time" }).press("End");
  await page.screenshot({ path: `${rehearsalEvidence}/workflow.png` });
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.screenshot({ path: `${rehearsalEvidence}/timeline.png` });
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.screenshot({ path: `${rehearsalEvidence}/details.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${rehearsalEvidence}/mobile.png` });
  return {
    status: "passed",
    checks: [
      "the rehearsal example opens on the production scheduler",
      "three browser tray chains are authored with a join, an earliest start and an injected slip",
      "a cyclic prerequisite is rejected without changing the plan",
      "stop after loading keeps the accepted step and its handoff",
      "the reopened run continues from the saved handoff",
      "the slip holds the cell and the join never stages",
      "the held run reopens without offering execution",
      "workflow, timeline, details and 390px evidence captured",
    ],
  };
}
