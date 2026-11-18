// Install the Plan 21 browser fixture, bundle this module, then call reviewSelects(page).
export async function reviewSelects(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-select-review";
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/portal/cafe-browser-lab/main/terminals`);
  const first = page.getByRole("combobox", { name: "First item", exact: true });
  const second = page.getByRole("combobox", {
    name: "Second item",
    exact: true,
  });
  await first.waitFor();
  await checkCaret(first);
  await checkCaret(second);
  await chooseOption(page, second, {
    label: "variant_financier · boutique_tokyo",
  });
  const sale = page.locator(".terminal-sale-form");
  const values = await sale.evaluate(readFormValues);
  if (values.counterItem !== values.counterItem2 || values.quantity !== "1")
    throw new Error("The counter selects changed their form values.");
  await first.focus();
  await page.keyboard.press("Tab");
  if (
    !(await page
      .getByRole("spinbutton", { name: "Quantity", exact: true })
      .evaluate(isFocused))
  )
    throw new Error("The shared select changed the counter form's tab order.");
  await sale.screenshot({ path: `${artifacts}/counter-desktop.png` });
  await page.setViewportSize({ width: 320, height: 900 });
  await checkCaret(first);
  await checkCaret(second);
  await sale.screenshot({ path: `${artifacts}/counter-narrow.png` });

  await page.goto(`${origin}/agent-components-preview.html`);
  const preview = page.getByRole("region", { name: "Select preview" });
  const item = preview.getByRole("combobox", {
    name: "First item",
    exact: true,
  });
  const pickup = preview.getByRole("combobox", {
    name: "Pickup location",
    exact: true,
  });
  await item.waitFor();
  await preview
    .getByRole("button", { name: "Review selection", exact: true })
    .click();
  if (!(await pickup.evaluate(isFocused)))
    throw new Error("Required selection did not focus its empty field.");
  await item.focus();
  // Typeahead on a closed trigger reads the items that Base UI mounts, hidden,
  // when the trigger takes focus.
  await page
    .locator('.pantry-select-item[data-value="madeleine"]')
    .waitFor({ state: "attached" });
  await page.keyboard.press("l");
  await page.keyboard.press("Tab");
  if ((await selectValue(item)) !== "madeleine")
    throw new Error("Keyboard selection did not update the controlled field.");
  await chooseOption(page, pickup, { value: "paris" });
  const shifts = preview.getByRole("combobox", {
    name: "Included shifts",
    exact: true,
  });
  await chooseOption(page, shifts, { values: ["afternoon", "evening"] });
  if (
    !(await preview
      .getByRole("combobox", { name: "Unavailable location", exact: true })
      .isDisabled())
  )
    throw new Error("The disabled select is interactive.");
  await preview
    .getByRole("button", { name: "Review selection", exact: true })
    .click();
  const submitted = new URLSearchParams(
    await preview.locator("output").innerText(),
  );
  if (
    submitted.get("item") !== "madeleine" ||
    submitted.get("location") !== "paris" ||
    submitted.has("unavailable") ||
    submitted.getAll("shifts").join(",") !== "afternoon,evening"
  )
    throw new Error(
      "Required, disabled, or multiple selection changed form submission.",
    );
  await checkCaret(item);
  await checkCaret(preview.locator('[dir=rtl] .pantry-select-trigger'));
  // A multiple Select is a dropdown too: one caret, and the chosen labels.
  await checkCaret(shifts);
  if ((await shifts.innerText()).trim() !== "Afternoon, Evening")
    throw new Error("The multiple Select does not show the chosen shifts.");
  await preview.screenshot({ path: `${artifacts}/component-narrow.png` });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await preview.screenshot({ path: `${artifacts}/component-desktop.png` });
  await page.evaluate(setDarkTheme);
  await checkCaret(item);
  await preview.screenshot({ path: `${artifacts}/component-dark.png` });
  await page.emulateMedia({ forcedColors: "active" });
  await checkCaret(item);
  const forced = await item.evaluate(readForcedColors);
  if (
    !forced.active ||
    forced.adjust === "none" ||
    forced.borderStyle === "none" ||
    forced.borderWidth < 1 ||
    forced.caretStroke !== "currentColor"
  )
    throw new Error(
      `Forced colors lost the trigger border or caret: ${JSON.stringify(forced)}`,
    );
  await preview.screenshot({
    path: `${artifacts}/component-forced-colors.png`,
  });
  await page.emulateMedia({ forcedColors: "none" });
  return {
    status: "passed",
    counterForm: "preserved",
    keyboardAndRequiredFields: "passed",
    disabledAndMultiple: "passed",
    longLabelsAndRtl: "passed",
    darkAndForcedColors: "passed",
    artifacts,
  };
}

// The shared trigger (apps/portal/src/ui/select.tsx) draws one caret at its
// trailing edge, and its label text stops before the caret.
async function checkCaret(locator) {
  const caret = await locator.evaluate(readCaret);
  if (
    caret.carets !== 1 ||
    caret.caretWidth < 14 ||
    caret.endInset < 4 ||
    caret.endInset > 16 ||
    caret.overlap > 0.5 ||
    caret.label.length === 0
  )
    throw new Error(
      `The page overrides the shared caret spacing: ${JSON.stringify(caret)}`,
    );
  if (caret.direction === "rtl" && !caret.trailing)
    throw new Error(
      `The caret did not move to the RTL trailing edge: ${JSON.stringify(caret)}`,
    );
}

function readCaret(trigger) {
  const style = getComputedStyle(trigger);
  const rtl = style.direction === "rtl";
  const box = trigger.getBoundingClientRect();
  const icons = trigger.querySelectorAll(".pantry-select-icon");
  const icon = icons.length === 0 ? null : icons[0].getBoundingClientRect();
  const value = trigger.querySelector('.pantry-select-value');
  const text = value === null ? null : value.getBoundingClientRect();
  const border = Number.parseFloat(
    rtl ? style.borderLeftWidth : style.borderRightWidth,
  );
  const middle = box.left + box.width / 2;
  return {
    direction: style.direction,
    carets: icons.length,
    caretWidth: icon === null ? 0 : icon.width,
    endInset:
      icon === null
        ? -1
        : (rtl ? icon.left - box.left : box.right - icon.right) - border,
    trailing:
      icon !== null &&
      (rtl
        ? icon.left + icon.width / 2 < middle
        : icon.left + icon.width / 2 > middle),
    overlap:
      icon === null || text === null
        ? 0
        : rtl
          ? icon.right - text.left
          : text.right - icon.left,
    label: value === null ? "" : value.textContent.trim(),
  };
}

function readForcedColors(trigger) {
  const style = getComputedStyle(trigger);
  const svg = trigger.querySelector(".pantry-select-icon > svg");
  return {
    active: matchMedia("(forced-colors: active)").matches,
    adjust: style.forcedColorAdjust,
    borderStyle: style.borderTopStyle,
    borderWidth: Number.parseFloat(style.borderTopWidth),
    caretStroke: svg === null ? null : svg.getAttribute("stroke"),
  };
}

function readFormValues(form) {
  return Object.fromEntries(new FormData(form));
}

function isFocused(element) {
  return document.activeElement === element;
}

function setDarkTheme() {
  document.documentElement.dataset.portalTheme = "dark";
}

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
