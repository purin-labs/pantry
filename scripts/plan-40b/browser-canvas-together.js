async (page) => {
  // The free canvas in two real browsers (Plan 40B phase 5, slice 4), against
  // a local Worker with its own D1 (the Plan 74 harness). The Portal's own
  // board client runs in both browsers: no stand-in.
  //
  // The owner makes a three-column board and moves it to the free canvas;
  // Undo and Redo move it back and forth. A second person (an admin) opens
  // the same board in a second browser and sees the owner's cursor. The
  // owner selects an area with a marquee, which selects only the elements
  // that it touches, and aligns them. The admin moves the heading at the
  // same time. The owner's Undo takes back only the owner's align; the
  // admin's move stays. A move back to a fixed layout puts the elements in
  // columns, and Undo returns them to the canvas where they were.
  //
  // Run: SATYR_ACCOUNT_WORKER_ARTIFACT=<built account Worker>
  //   python3 scripts/plan-74/run-browser.py --journey scripts/plan-40b/browser-canvas-together.js \
  //   --entry /menus-preview.html --artifacts output/playwright/plan-40b-canvas
  const WORKER = "http://127.0.0.1:8874";
  const PORTAL = "http://127.0.0.1:3174";
  const fixtures = JOURNEY_FIXTURES;
  const ARTIFACTS = JOURNEY_ARTIFACTS;
  const checks = [];
  const captures = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  };
  const capture = async (target, name) => {
    await target.screenshot({ path: `${ARTIFACTS}/${name}.png` });
    captures.push(`${name}.png`);
  };
  // The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
    if ("values" in choice) {
      const wanted = choice.values.map(String);
      for (const item of await items.all()) {
        const chosen = wanted.includes(await item.getAttribute("data-value"));
        const selected = (await item.getAttribute("aria-selected")) === "true";
        if (chosen !== selected) await item.click();
      }
      await page.keyboard.press("Escape");
    } else if ("value" in choice) {
      await popup
        .locator(
          `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
        )
        .click();
    } else if ("label" in choice) {
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }

  // The form value of a Portal Select. Base UI keeps it in a hidden input that
  // it renders after the Select's parts.
  function selectValue(trigger) {
    return trigger.evaluate(function hiddenSelectValue(button) {
      for (let node = button; node !== null; node = node.parentElement) {
        for (
          let next = node.nextElementSibling;
          next !== null;
          next = next.nextElementSibling
        ) {
          if (
            next instanceof HTMLInputElement &&
            next.getAttribute("aria-hidden") === "true"
          )
            return next.value;
        }
      }
      throw new Error("A Portal Select has no hidden input.");
    });
  }

  const boardUrl = `${PORTAL}/menus-preview.html?organisation=${fixtures.organisationId}&tab=boards`;
  // The rect of each canvas element in board units, as the editor places
  // its hit box over the element.
  const rects = (target) => target.locator(".menu-canvas-hit").evaluateAll((hits) =>
    Object.fromEntries(hits.map((hit) => [hit.dataset.elementId, {
      x: Number.parseFloat(hit.style.left),
      y: Number.parseFloat(hit.style.top),
      width: Number.parseFloat(hit.style.width),
      height: Number.parseFloat(hit.style.height),
    }])));
  const saved = (target) => target.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
  const layoutOf = (target) => selectValue(target.getByRole("combobox", { name: "Layout", exact: true }));
  const pressed = (target) => target.locator(".menu-canvas-layers li button[aria-pressed='true']").count();
  const waitFor = async (name, read, expected, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
      value = await read();
      if (JSON.stringify(value) === JSON.stringify(expected)) return value;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    check(name, false, { expected, got: value });
    return value;
  };

  const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
  if (!session.ok()) throw new Error("Session failed for Owner");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(boardUrl);

  // 1. The owner makes a board from three columns and moves it to the canvas.
  await page.locator(".menu-board-start, .menu-boards-chips").first().waitFor({ timeout: 15_000 });
  if (!(await page.locator(".menu-board-start").isVisible())) await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Canvas together");
  await page.locator(`.menu-boards-new input[value="three_columns:template"]`).check();
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await page.locator(".menu-board-element-order_qr").waitFor({ timeout: 15_000 });
  await saved(page);
  check("the board starts in three columns", (await layoutOf(page)) === "three_columns");
  await page.getByRole("combobox", { name: "Layout", exact: true }).click();
  await page.getByRole("option", { name: "Free canvas · landscape TV", exact: true }).click();
  await page.locator(".menu-canvas-hit").first().waitFor();
  await saved(page);
  const firstCanvas = await rects(page);
  check("every element has a place on the canvas", Object.keys(firstCanvas).length === 2, firstCanvas);
  await capture(page, "01-owner-canvas");

  // 2. Undo and Redo of the layout move, in the Portal's own client.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor("Undo returns to three columns", () => layoutOf(page), "three_columns");
  check("the fixed layout has no canvas", (await page.locator(".menu-canvas").count()) === 0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await waitFor("Redo returns to the canvas", () => layoutOf(page), "canvas_landscape");
  await waitFor("Redo returns each element to its rect", () => rects(page), firstCanvas);
  await saved(page);

  // 3. The owner adds two text elements and moves them apart with the keys.
  const add = page.getByRole("combobox", { name: "Add", exact: true });
  const texts = [];
  for (const [label, presses, key] of [["Oat milk +¥50", 40, "ArrowLeft"], ["Decaf any drink", 40, "ArrowRight"]]) {
    const before = new Set(Object.keys(await rects(page)));
    await chooseOption(page, add, { value: "text" });
    const drawer = page.getByRole("complementary", { name: "Selected text" });
    await drawer.getByLabel("Text", { exact: true }).fill(label);
    const id = Object.keys(await rects(page)).find((candidate) => !before.has(candidate));
    texts.push(id);
    await page.locator(`.menu-canvas-hit[data-element-id="${id}"]`).click();
    for (let index = 0; index < presses; index += 1) await page.keyboard.press(`Shift+${key}`);
  }
  await saved(page);
  const placed = await rects(page);
  check("the two texts sit apart", Math.abs(placed[texts[0]].x - placed[texts[1]].x) >= 700, placed);

  // 4. The admin opens the same board in a second browser.
  const otherContext = await page.context().browser().newContext();
  const other = await otherContext.newPage();
  await other.setViewportSize({ width: 1440, height: 1000 });
  const otherSession = await other.request.post(`${WORKER}/test/session?user=Other`);
  if (!otherSession.ok()) throw new Error("Session failed for Other");
  await other.goto(boardUrl);
  await other.locator(".menu-canvas-hit").first().waitFor({ timeout: 15_000 });
  await saved(other);
  await waitFor("the second browser shows the same board", () => rects(other), placed);
  // The owner's cursor shows in the admin's browser.
  const ownerStage = await page.locator(".menu-canvas-overlay").boundingBox();
  await page.mouse.move(ownerStage.x + ownerStage.width * 0.5, ownerStage.y + ownerStage.height * 0.9);
  await page.mouse.move(ownerStage.x + ownerStage.width * 0.52, ownerStage.y + ownerStage.height * 0.88);
  await other.locator(".menu-canvas-cursor").first().waitFor({ timeout: 10_000 });
  check("the admin sees the owner's cursor", (await other.locator(".menu-canvas-cursor span").first().textContent())?.includes("Owner"));
  await capture(other, "02-admin-sees-owner");

  // 5. A marquee selects the two texts and nothing else. The expected set
  // comes from the boxes that the browser drew, not from the editor.
  const boxes = Object.fromEntries(await Promise.all(Object.keys(placed).map(async (id) =>
    [id, await page.locator(`.menu-canvas-hit[data-element-id="${id}"]`).boundingBox()])));
  const area = {
    left: Math.min(boxes[texts[0]].x, boxes[texts[1]].x) - 6,
    top: Math.min(boxes[texts[0]].y, boxes[texts[1]].y) - 6,
    right: Math.max(boxes[texts[0]].x + boxes[texts[0]].width, boxes[texts[1]].x + boxes[texts[1]].width) + 6,
    bottom: Math.max(boxes[texts[0]].y + boxes[texts[0]].height, boxes[texts[1]].y + boxes[texts[1]].height) + 6,
  };
  const expected = Object.entries(boxes).filter(([, box]) =>
    box.x < area.right && area.left < box.x + box.width && box.y < area.bottom && area.top < box.y + box.height,
  ).map(([id]) => id).sort();
  const startsEmpty = await page.evaluate(([x, y]) =>
    document.elementFromPoint(x, y)?.classList.contains("menu-canvas-overlay") === true, [area.left, area.top]);
  check("the marquee starts on the empty board", startsEmpty, area);
  await page.mouse.move(area.left, area.top);
  await page.mouse.down();
  await page.mouse.move((area.left + area.right) / 2, (area.top + area.bottom) / 2, { steps: 4 });
  await page.mouse.move(area.right, area.bottom, { steps: 4 });
  const highlighted = await page.locator(".menu-canvas-hit[data-marquee='true']").evaluateAll((hits) =>
    hits.map((hit) => hit.dataset.elementId).sort());
  check("during the drag the marquee marks the elements that it touches", JSON.stringify(highlighted) === JSON.stringify(expected), { highlighted, expected });
  await capture(page, "03-marquee");
  await page.mouse.up();
  const selectedIds = await page.locator(".menu-canvas-hit[data-selected='true']").evaluateAll((hits) =>
    hits.map((hit) => hit.dataset.elementId).sort());
  check("the marquee selects exactly the elements that it touches", JSON.stringify(selectedIds) === JSON.stringify(expected), { selectedIds, expected });
  check("the marquee holds both texts", texts.every((id) => expected.includes(id)), expected);
  check("the layers list shows the same selection", (await pressed(page)) === expected.length);

  // 6. The owner aligns the selection while the admin moves the heading.
  const headingId = Object.keys(placed).find((id) => !texts.includes(id) &&
    placed[id].y === Math.min(...Object.values(placed).map((rect) => rect.y)));
  const headingStart = placed[headingId];
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await other.locator(`.menu-canvas-hit[data-element-id="${headingId}"]`).click();
  for (let index = 0; index < 5; index += 1) await other.keyboard.press("Shift+ArrowDown");
  await saved(page);
  await saved(other);
  const aligned = await waitFor("the owner's align reaches the admin", async () => {
    const shown = await rects(other);
    return [shown[texts[0]].y === shown[texts[1]].y, shown[headingId].y];
  }, [true, headingStart.y + 50]);
  // The admin's moves reach the owner a moment later; both boards must
  // then show the same rects.
  const together = await waitFor("the admin's move reaches the owner", async () => {
    const shown = await rects(page);
    return [shown[texts[0]].y === shown[texts[1]].y, shown[headingId].y];
  }, [true, headingStart.y + 50]).then(() => rects(page));
  await waitFor("both browsers converge", () => rects(other), together);
  check("the heading moved by the admin", together[headingId].y === headingStart.y + 50, together[headingId]);
  await capture(page, "04-converged-owner");
  await capture(other, "05-converged-admin");

  // 7. The owner's Undo takes back the align only.
  await page.locator(".menu-canvas").focus();
  await page.keyboard.press("ControlOrMeta+z");
  const undone = await waitFor("Undo restores the owner's texts", async () => {
    const shown = await rects(other);
    return [shown[texts[0]].y, shown[texts[1]].y, shown[headingId].y];
  }, [placed[texts[0]].y, placed[texts[1]].y, headingStart.y + 50]);
  check("Undo keeps the admin's move", undone[2] === headingStart.y + 50, undone);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await waitFor("Redo aligns again", async () => {
    const shown = await rects(other);
    return shown[texts[0]].y === shown[texts[1]].y;
  }, true);
  await saved(page);
  const beforeFixed = await rects(page);

  // 8. Back to a fixed layout, and Undo to the canvas.
  await page.getByRole("combobox", { name: "Layout", exact: true }).click();
  await page.getByRole("option", { name: "Three columns · landscape TV", exact: true }).click();
  await page.locator(".menu-board-column .menu-board-element").first().waitFor();
  await waitFor("the admin also sees three columns", () => layoutOf(other), "three_columns");
  const inColumns = await other.locator(".menu-board-column .menu-board-element, .menu-board-header .menu-board-element").count();
  check("every element sits in a frame of the fixed layout", inColumns === 4, inColumns);
  await capture(other, "06-admin-fixed-layout");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor("Undo returns the canvas in both browsers", () => rects(other), beforeFixed);
  await saved(page);
  await capture(other, "07-admin-canvas-again");
  await otherContext.close();
  return {
    result: "passed",
    checks,
    captures,
    board: { elements: Object.keys(beforeFixed).length, marquee: expected.length, aligned: aligned[0] },
  };
}
