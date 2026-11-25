// E2E browser verification for Costs & margins (KIT-04) Undo/Redo:
// Ctrl+Z / Ctrl+Shift+Z (and Undo / Redo header buttons) across live cell
// keystroke coalescing, cross-cell focus, uncommitted back-solve cancellation,
// formula bar Escape cancel, Reset undo/redo, Search box isolation, and 12w Cash.
const costsUndoEvidence =
  globalThis.bakeryEvidence ?? "output/playwright/costs-undo-redo";

async function expectValue(locator, expected, label) {
  const actual = await locator.inputValue();
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function expectNotValue(locator, forbidden, label) {
  const actual = await locator.inputValue();
  if (actual === forbidden) {
    throw new Error(
      `${label}: expected value to differ from ${JSON.stringify(forbidden)}`,
    );
  }
}

async function expectDisabled(locator, expected, label) {
  const actual = await locator.isDisabled();
  if (actual !== expected) {
    throw new Error(
      `${label}: expected disabled=${String(expected)}, got ${String(actual)}`,
    );
  }
}

async function selectAllAndType(page, locator, text) {
  await locator.click();
  await locator.selectText();
  await page.keyboard.type(text);
}

async function verifyCostsUndoRedoBrowser(page) {
  page.setDefaultTimeout(20000);
  const base =
    globalThis.bakeryBase ?? (await page.evaluate("location.origin"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/kitchen-preview.html?page=costs`);

  const undoButton = page.getByRole("button", { name: "Undo", exact: true });
  const redoButton = page.getByRole("button", { name: "Redo", exact: true });
  const resetButton = page.getByRole("button", { name: "Reset", exact: true });
  const priceCell = page.locator(
    '[data-sheet-row="0"][data-sheet-col="price"]',
  );
  const marginCell = page.locator(
    '[data-sheet-row="0"][data-sheet-col="margin"]',
  );
  const unitsCell = page.locator(
    '[data-sheet-row="0"][data-sheet-col="units"]',
  );

  await priceCell.waitFor({ state: "visible" });
  await undoButton.waitFor({ state: "visible" });
  await redoButton.waitFor({ state: "visible" });

  await expectDisabled(undoButton, true, "Initial Undo button");
  await expectDisabled(redoButton, true, "Initial Redo button");

  const initialPrice = await priceCell.inputValue();
  const initialUnits = await unitsCell.inputValue();
  const initialMargin = await marginCell.inputValue();

  // 1. Live keystroke coalescing + immediate Ctrl+Z / Ctrl+Shift+Z while focused.
  await selectAllAndType(page, priceCell, "750");
  await expectValue(priceCell, "750", "Price after typing 750");
  await expectDisabled(undoButton, false, "Undo enabled after edit");
  await expectDisabled(redoButton, true, "Redo disabled after new edit");

  await page.keyboard.press("Control+z");
  await expectValue(
    priceCell,
    initialPrice,
    "Single Ctrl+Z coalesces 750 keystrokes back to initial price",
  );
  await expectDisabled(undoButton, true, "Undo disabled after reverting edit");
  await expectDisabled(redoButton, false, "Redo enabled after undo");

  await page.keyboard.press("Control+Shift+z");
  await expectValue(priceCell, "750", "Ctrl+Shift+Z redoes price to 750");
  await expectDisabled(undoButton, false, "Undo re-enabled after redo");
  await expectDisabled(redoButton, true, "Redo disabled at top of stack");

  // 2. Edit Price to 0, move focus to Margin cell, then Ctrl+Z / Ctrl+Shift+Z.
  await selectAllAndType(page, priceCell, "0");
  await expectValue(priceCell, "0", "Price set to 0");
  await marginCell.click();
  await expectValue(marginCell, "0.0", "Margin shows 0.0 when price is 0");
  await page.screenshot({
    path: `${costsUndoEvidence}/01-margins-before-undo.png`,
  });

  await page.keyboard.press("Control+z");
  await expectValue(
    priceCell,
    "750",
    "Ctrl+Z from focused Margin cell restores Price to 750",
  );
  await expectNotValue(
    marginCell,
    "0.0",
    "Focused Margin cell updates immediately on undo",
  );
  await page.screenshot({
    path: `${costsUndoEvidence}/02-margins-after-undo.png`,
  });

  await page.keyboard.press("Control+Shift+z");
  await expectValue(
    priceCell,
    "0",
    "Ctrl+Shift+Z from focused Margin cell redoes Price to 0",
  );
  await expectValue(
    marginCell,
    "0.0",
    "Focused Margin cell updates back to 0.0 on redo",
  );

  // Two undos walk 0 -> 750 -> initialPrice (also test Meta+Z / Meta+Shift+Z).
  await page.keyboard.press("Meta+z");
  await expectValue(priceCell, "750", "Meta+Z steps 0 -> 750");
  await page.keyboard.press("Meta+Shift+z");
  await expectValue(priceCell, "0", "Meta+Shift+Z steps 750 -> 0");
  await page.keyboard.press("Control+z");
  await expectValue(priceCell, "750", "First Ctrl+Z steps 0 -> 750");
  await page.keyboard.press("Control+z");
  await expectValue(
    priceCell,
    initialPrice,
    "Second Ctrl+Z steps 750 -> initialPrice",
  );
  await expectDisabled(undoButton, true, "Undo disabled at baseline");

  // 3. Uncommitted back-solve text cancels before undoing an earlier committed edit.
  await selectAllAndType(page, unitsCell, "42");
  await expectValue(unitsCell, "42", "Units edited to 42");
  const marginAt42Units = await marginCell.inputValue();

  await selectAllAndType(page, marginCell, "55");
  await expectValue(marginCell, "55", "Uncommitted margin draft typed");

  await page.keyboard.press("Control+z");
  await expectValue(
    marginCell,
    marginAt42Units,
    "First Ctrl+Z cancels uncommitted Margin text",
  );
  await expectValue(
    unitsCell,
    "42",
    "Earlier committed Units edit stays intact after cancelling uncommitted text",
  );

  await page.keyboard.press("Control+z");
  await expectValue(
    unitsCell,
    initialUnits,
    "Second Ctrl+Z undoes committed Units edit",
  );
  await expectValue(
    marginCell,
    initialMargin,
    "Margin returns to initial baseline after undoing Units",
  );

  // 4. Committed back-solve + Formula bar Escape cancel + Reset undo/redo.
  await selectAllAndType(page, marginCell, "50");
  await page.keyboard.press("Enter");
  const solvedPrice = await priceCell.inputValue();
  if (solvedPrice === initialPrice) {
    throw new Error(
      `Expected back-solving 50% margin to change price from ${initialPrice}`,
    );
  }

  await page.keyboard.press("Control+z");
  await expectValue(priceCell, initialPrice, "Ctrl+Z undoes back-solve price");
  await page.keyboard.press("Control+Shift+z");
  await expectValue(
    priceCell,
    solvedPrice,
    "Ctrl+Shift+Z redoes back-solve price",
  );

  // Formula bar Escape must cancel rather than commit.
  await priceCell.click();
  const fxInput = page.locator(".costs-fx-input");
  await selectAllAndType(page, fxInput, "= PRICE * 2");
  await page.keyboard.press("Escape");
  await expectValue(
    priceCell,
    solvedPrice,
    "Escape in formula bar cancels without committing",
  );

  // Reset clears draft and is itself undoable and redoable.
  await resetButton.click();
  await expectValue(priceCell, initialPrice, "Reset restores initial price");
  await expectDisabled(undoButton, false, "Undo remains enabled after Reset");

  await page.keyboard.press("Control+z");
  await expectValue(priceCell, solvedPrice, "Ctrl+Z undoes Reset");
  await page.keyboard.press("Control+Shift+z");
  await expectValue(priceCell, initialPrice, "Ctrl+Shift+Z redoes Reset");

  // 5. Search box keeps native input handling and never triggers workbook undo.
  const searchInput = page.locator(".costs-search-box input");
  await searchInput.click();
  await page.keyboard.type("Brioche");
  await page.keyboard.press("Control+z");
  await searchInput.fill("");
  await expectValue(
    priceCell,
    initialPrice,
    "Ctrl+Z in Search box did not undo workbook Reset",
  );

  // 6. 12w Cash (forecast) tab edits support Ctrl+Z, Ctrl+Shift+Z, and Undo/Redo buttons.
  await page.locator('[data-surface-target="tab:forecast"]').click();
  const openingCashInput = page.getByLabel("Opening bank cash", {
    exact: true,
  });
  await openingCashInput.waitFor({ state: "visible" });
  const initialOpeningCash = await openingCashInput.inputValue();

  await selectAllAndType(page, openingCashInput, "8000000");
  await openingCashInput.blur();
  await expectValue(
    openingCashInput,
    "8,000,000",
    "Opening bank cash updated to 8,000,000",
  );
  await page.screenshot({
    path: `${costsUndoEvidence}/03-forecast-after-edit.png`,
  });

  await page.keyboard.press("Control+z");
  await expectValue(
    openingCashInput,
    initialOpeningCash,
    "Ctrl+Z on 12w Cash reverts Opening bank cash",
  );
  await page.keyboard.press("Control+Shift+z");
  await expectValue(
    openingCashInput,
    "8,000,000",
    "Ctrl+Shift+Z on 12w Cash redoes Opening bank cash",
  );

  await undoButton.click();
  await expectValue(
    openingCashInput,
    initialOpeningCash,
    "Undo header button reverts Opening bank cash",
  );
  await redoButton.click();
  await expectValue(
    openingCashInput,
    "8,000,000",
    "Redo header button restores Opening bank cash",
  );
  await page.screenshot({
    path: `${costsUndoEvidence}/04-forecast-after-redo.png`,
  });

  return {
    result: "passed",
    status: "passed",
    initialPrice,
    solvedPrice,
    initialUnits,
    initialOpeningCash,
  };
}
