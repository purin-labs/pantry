// Plan 42F F1c: a rehearsal tray runs from native files. Opening a native
// request adds a tray; each native result is opened with the handoff its
// successor resumes from; a continuation exports its resume handoff. Generate
// the files with native-import-fixture.mjs, then run with the Playwright CLI.
const importBase = globalThis.bakeryBase ?? "http://127.0.0.1:5188";
const importEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan42f-native-import";

function importNotice(page, text) {
  return page
    .locator(".production-panel .production-notice")
    .filter({ hasText: text })
    .waitFor({ timeout: 30000 });
}
function operationSelect(page) {
  return page
    .locator(".production-panel label", { hasText: /^Native operation/ })
    .locator(".pantry-select-trigger");
}
async function openNativeFile(page, name) {
  await page
    .getByLabel("Open production run or native recording", { exact: true })
    .setInputFiles(`${importEvidence}/${name}.json`);
}
async function acceptNative(page, operationId, name, notice) {
  await chooseOption(page, operationSelect(page), { value: operationId });
  await openNativeFile(page, name);
  await importNotice(page, "File checked.");
  await page
    .getByRole("button", { name: "Accept matching native result", exact: true })
    .click();
  await importNotice(page, notice);
}

async function verifyNativeImportBrowser(page) {
  await page.goto(`${importBase}/workflow-preview.html`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRobotRehearsal(page);
  await importNotice(page, "Rehearsal prepared with two recorded trays.");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await openNativeFile(page, "loading-request");
  await importNotice(page, "Native request added as a new tray.");
  await page.getByRole("button", { name: "Files", exact: true }).click();

  await acceptNative(
    page,
    "batch:C:native:1",
    "loading-handoff",
    "Native result and handoff accepted.",
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await chooseOption(page, operationSelect(page), {
    value: "batch:C:native:1:2",
  });
  const [handoff] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Export resume handoff", exact: true })
      .click(),
  ]);
  await handoff.saveAs(`${importEvidence}/exported-loading-handoff.json`);
  await acceptNative(
    page,
    "batch:C:native:1:2",
    "retrieval-handoff",
    "Native result and handoff accepted.",
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await acceptNative(
    page,
    "batch:C:native:1:3",
    "racked",
    "Matching native evidence accepted.",
  );
  const [saved] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Save production run", exact: true })
      .click(),
  ]);
  await saved.saveAs(`${importEvidence}/final.json`);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.screenshot({ path: `${importEvidence}/timeline.png` });
  return {
    status: "passed",
    checks: [
      "a native loading request adds a tray with its retrieval and racking planned",
      "a loading result with its handoff binds the retrieval request",
      "the retrieval exports the handoff it resumes from",
      "a retrieval result with its handoff binds the racking request",
      "the racked result completes the tray",
    ],
  };
}
