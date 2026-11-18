// Plan 42F F1c: rehearsal outages, injected failures, assumed recovery and a
// pinned baseline on the production scheduler. Run with the Playwright CLI.
const faultBase = globalThis.bakeryBase ?? "http://127.0.0.1:5188";
const faultEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan42f-rehearsal-faults";

function faultNotice(page, text) {
  return page
    .locator(".production-panel .production-notice")
    .filter({ hasText: text })
    .waitFor({ timeout: 30000 });
}
function faultRunStatus(page, text, timeout = 180000) {
  return page
    .locator(".production-browser-run p")
    .filter({ hasText: text })
    .waitFor({ timeout });
}
// A Select's label text includes its chosen item, so match the label's
// start. Base UI puts the Select's hidden input inside the label too.
function faultField(page, label) {
  return page
    .locator(".production-faults label", {
      hasText: new RegExp(`^${label.replace(/[()]/g, "\\$&")}`),
    })
    .locator('.pantry-select-trigger, input:not([aria-hidden="true"])');
}
function comparison(page) {
  return page.locator(".production-baseline p[role=status]");
}
async function faultTime(page, label, value, notice) {
  const input = faultField(page, label);
  await input.fill(String(value));
  await input.press("Tab");
  await faultNotice(page, notice);
}
async function saveFaultRun(page, name) {
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Save production run", exact: true })
      .click(),
  ]);
  await download.saveAs(`${faultEvidence}/${name}.json`);
}

async function verifyRehearsalFaultsBrowser(page) {
  await page.goto(`${faultBase}/workflow-preview.html`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRobotRehearsal(page);
  await faultNotice(page, "Rehearsal prepared with two recorded trays.");
  await editInputs(page);
  await page
    .getByRole("button", { name: "Pin current run as baseline", exact: true })
    .click();
  await faultNotice(page, "Current run pinned as the comparison baseline.");
  const same = await comparison(page).textContent();
  if (same !== "Same outcome as the baseline.")
    throw new Error(`A fresh baseline must match: ${same}`);

  // The arm is out from 60 s to 400 s: running work finishes, new work waits.
  await chooseOption(page, faultField(page, "Unavailable resource"), {
    label: "FR10 arm",
  });
  await faultNotice(page, "FR10 arm outage applied.");
  await faultTime(page, "Unavailable from (s)", 60, "Outage window changed.");
  await faultTime(page, "Available again (s)", 400, "Outage window changed.");
  const outage = await comparison(page).textContent();
  if (!/later than the baseline/.test(outage))
    throw new Error(`The outage must delay the run: ${outage}`);

  // B's staging fails 10 s in; a 60 s recovery releases its baker and cell.
  await chooseOption(page, faultField(page, "Injected failure"), {
    label: "Tray B staging",
  });
  await faultNotice(page, "Failure injected.");
  const failed = await comparison(page).textContent();
  if (!/1 more unfinished tray\. 1 more failed task\./.test(failed))
    throw new Error(`The failure must be compared: ${failed}`);
  await chooseOption(page, faultField(page, "Assumed recovery"), {
    label: "Tray B staging",
  });
  await faultNotice(page, "Recovery assumed");
  await faultTime(
    page,
    "Recovery duration (s)",
    60,
    "Recovery duration changed.",
  );
  await page.screenshot({
    path: `${faultEvidence}/author.png`,
    fullPage: true,
  });

  // A new browser chain takes the cell after B's recovery and the outage.
  await page
    .getByRole("button", { name: "Add browser tray chain", exact: true })
    .click();
  await faultNotice(page, "Loading, retrieval and racking are planned.");
  await saveFaultRun(page, "authored");
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await faultRunStatus(
    page,
    "Tray B staging failed; the recovery released the cell",
  );
  await saveFaultRun(page, "final");

  await page
    .getByLabel("Open production run or native recording", {
      exact: true,
    })
    .setInputFiles(`${faultEvidence}/final.json`);
  await page
    .getByRole("button", { name: "Use saved production run", exact: true })
    .click();
  await faultNotice(page, "Saved rehearsal reopened paused");
  await editInputs(page);
  const kept = await selectValue(faultField(page, "Assumed recovery"));
  if (kept !== "batch:B:handoff:1-stage")
    throw new Error(`The reopened run lost its recovery: ${kept}`);
  const pinned = await comparison(page).textContent();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.getByRole("slider", { name: "Production time" }).press("End");
  await page.screenshot({ path: `${faultEvidence}/timeline.png` });
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.screenshot({ path: `${faultEvidence}/workflow.png` });
  await editInputs(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${faultEvidence}/mobile.png`,
    fullPage: true,
  });
  return {
    status: "passed",
    comparisons: { outage, failed, pinned },
    checks: [
      "a pinned baseline starts equal to the current run",
      "an FR10 arm outage delays the run against the baseline",
      "an injected staging failure is compared as one more failed task",
      "an assumed recovery releases the cell so a browser chain runs",
      "the browser run stops at the recovered failure without executing it",
      "faults save and reopen with the rehearsal",
      "author, timeline, workflow and 390px evidence captured",
    ],
  };
}
