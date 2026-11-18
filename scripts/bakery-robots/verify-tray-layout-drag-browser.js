// Plan 42F F1c: drag a rehearsal tray's rack in its layout preview, review and
// apply the placement, then simulate it in browser MuJoCo. Run with the
// Playwright CLI.
const dragEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/plan42f-tray-layout-drag";

function dragNotice(page, text) {
  return page
    .locator(".production-panel .production-notice")
    .filter({ hasText: text })
    .waitFor({ timeout: 30000 });
}
// The room outline states its assumed width in metres.
async function millimetresPerPixel(plan) {
  const room = plan.locator(".spatial-room-boundary");
  const label = await room.getAttribute("aria-label");
  const width = Number(/Assumed room: ([\d.]+) by/.exec(label ?? "")?.[1]);
  const box = await room.boundingBox();
  if (!Number.isFinite(width) || box === null)
    throw new Error("Missing the room outline in the tray layout preview.");
  return (width * 1000) / box.width;
}
async function dragRack(page, rack, xMm, yMm, scale) {
  await rack.scrollIntoViewIfNeeded();
  const box = await rack.boundingBox();
  if (box === null) throw new Error("Missing the rack in the floor plan.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + xMm / scale, y - yMm / scale, { steps: 6 });
  await page.mouse.up();
}
async function offsets(editor) {
  return [
    Number(
      await editor
        .getByRole("spinbutton", { name: "X offset (mm)", exact: true })
        .inputValue(),
    ),
    Number(
      await editor
        .getByRole("spinbutton", { name: "Y offset (mm)", exact: true })
        .inputValue(),
    ),
  ];
}
function near(value, expected, tolerance) {
  return Math.abs(value - expected) <= tolerance;
}

async function verifyTrayLayoutDragBrowser(page) {
  page.setDefaultTimeout(15000);
  // The acceptance runner opens the preview itself and sets no base.
  const base =
    globalThis.bakeryBase ?? (await page.evaluate("location.origin"));
  await page.goto(`${base}/workflow-preview.html`);
  await page.setViewportSize({ width: 1440, height: 900 });
  const hasWebGL = await page.evaluate(
    'Boolean(document.createElement("canvas").getContext("webgl2"))',
  );
  await openRobotRehearsal(page);
  await dragNotice(page, "Rehearsal prepared with two recorded trays.");
  await editInputs(page);
  await chooseOption(
    page,
    page.locator(".production-rehearsal-preset .pantry-select-trigger"),
    { label: "Table to rack" },
  );
  await page
    .getByRole("button", { name: "Replace with preset", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply rehearsal change", exact: true })
    .click();
  await dragNotice(page, "Table to rack opened from its recorded result.");

  const editor = page.locator(".production-panel .rack-layout-editor");
  if ((await editor.locator(".production-layout-preview").count()) !== 0)
    throw new Error(
      "The preview must mount only while the experiment is open.",
    );
  await editor
    .getByText("Rack placement experiment · Tray A", { exact: true })
    .click();
  const preview = editor.locator(".production-layout-preview");
  const plan = preview.locator(".spatial-floor-plan");
  await plan.waitFor({ state: "visible", timeout: 30000 });
  await preview.scrollIntoViewIfNeeded();
  const rack = plan.locator(
    '.spatial-floor-map button[data-resource="rack-slot-1"]',
  );
  await rack.waitFor();
  if ((await rack.getAttribute("data-draggable")) !== "true")
    throw new Error("The tray's rack must be draggable in its preview.");
  if (
    (await plan
      .locator('.spatial-floor-map button[data-draggable="true"]')
      .count()) !== 1
  )
    throw new Error("Only the rack may be draggable.");
  const scale = await millimetresPerPixel(plan);

  // Dragging the rack writes the same numeric draft in model millimetres.
  await dragRack(page, rack, 200, 0, scale);
  const [draggedX, draggedY] = await offsets(editor);
  if (!near(draggedX, 200, 20) || !near(draggedY, 0, 5))
    throw new Error(
      `Dragging must set X ≈ 200, Y ≈ 0 mm; got ${draggedX}, ${draggedY}.`,
    );
  if (
    (await plan
      .locator(".spatial-original-placement:not([hidden])")
      .count()) !== 1
  )
    throw new Error("The applied rack position must remain as a ghost.");
  await page.screenshot({ path: `${dragEvidence}/drag.png` });
  await editor
    .getByRole("button", { name: "Discard rack placement", exact: true })
    .click();
  if ((await offsets(editor)).join() !== "0,0")
    throw new Error("Discard must restore the applied position.");

  // A drag toward the table is checked live in the same preview.
  await dragRack(page, rack, 200, -560, scale);
  await editor
    .locator(":scope > p[role=status]")
    .filter({ hasText: /^Blocked:/ })
    .waitFor();
  if (
    (await plan
      .locator('.spatial-floor-map button[data-fit="blocked"]')
      .count()) < 2
  )
    throw new Error(
      "A blocked drag must outline the rack and the obstruction.",
    );
  await page.screenshot({ path: `${dragEvidence}/blocked.png` });
  await editor
    .getByRole("button", { name: "Discard rack placement", exact: true })
    .click();

  // Review and apply a dragged placement, then simulate it in the browser.
  await dragRack(page, rack, 200, 0, scale);
  const [reviewedX] = await offsets(editor);
  await editor
    .getByRole("button", { name: "Review rack placement", exact: true })
    .click();
  const review = editor.getByRole("region", {
    name: "Rack placement review",
    exact: true,
  });
  await review.waitFor();
  await review
    .getByRole("button", { name: "Apply rack placement", exact: true })
    .click();
  await dragNotice(page, "Rack placement applied to tray A.");
  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await page
    .locator(".production-browser-run p")
    .filter({ hasText: "Browser run complete." })
    .waitFor({ timeout: 240000 });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const [saved] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Save production run", exact: true })
      .click(),
  ]);
  await saved.saveAs(`${dragEvidence}/applied.json`);

  // The applied placement reopens with no draft and no ghost.
  await editInputs(page);
  await editor
    .getByText("Rack placement experiment · Tray A", { exact: true })
    .click();
  await plan.waitFor({ state: "visible", timeout: 30000 });
  const [appliedX, appliedY] = await offsets(editor);
  if (appliedX !== reviewedX || appliedY !== 0)
    throw new Error(
      `The applied offsets must reopen; got ${appliedX}, ${appliedY}.`,
    );
  if (
    (await plan
      .locator(".spatial-original-placement:not([hidden])")
      .count()) !== 0
  )
    throw new Error("An applied placement has no ghost.");
  await page.screenshot({ path: `${dragEvidence}/applied.png` });
  return {
    status: "passed",
    renderer: hasWebGL ? "webgl" : "floor-plan fallback",
    millimetresPerPixel: scale,
    dragged: [draggedX, draggedY],
    applied: [appliedX, appliedY],
    checks: [
      "the layout preview mounts only while the experiment is open",
      "only the tray's rack is draggable",
      "dragging writes the numeric draft in model millimetres and keeps the applied ghost",
      "discard restores the applied position",
      "a blocked drag outlines the rack and the obstruction",
      "a dragged placement is reviewed, applied and simulated in browser MuJoCo",
      "the applied placement reopens without a draft",
    ],
  };
}
