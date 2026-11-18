// Page helpers of the Playwright browser journeys. Each one takes the page or
// a locator and uses the Portal control as a person does.
//
// A run-code journey cannot import a module. browser-acceptance.mjs puts the
// source of these functions in front of each bakery journey (see
// `pageHelperSource`), so the journey calls them as its own helpers. A Node
// script imports them, and a bundled journey bundles them. Keep each function
// self-contained: it has no imports and calls no other helper.

// The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
// combobox that opens a listbox popup. Choose by { value }, { label } or
// { index }. { values } sets the items of a multiple Select, then Escape
// closes its popup.
export async function chooseOption(page, trigger, choice) {
  await trigger.click();
  const popup = page.locator(".pantry-select-popup[data-open]");
  await popup.waitFor();
  const items = popup.locator(".pantry-select-item");
  if ("values" in choice) {
    const wanted = choice.values.map(String);
    for (const item of await items.all()) {
      const chosen = wanted.includes(await item.getAttribute("data-value"));
      const selected = (await item.getAttribute("aria-selected")) === "true";
      if (chosen !== selected) {
        await item.click();
      }
    }
    await page.keyboard.press("Escape");
  } else if ("value" in choice) {
    await popup
      .locator(
        `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
      )
      .click();
  } else if ("label" in choice) {
    await popup
      .getByRole("option", { name: choice.label, exact: true })
      .click();
  } else {
    await items.nth(choice.index).click();
  }
  await popup.waitFor({ state: "hidden" });
}

// The items of a Portal Select, read from its open popup, which Escape then
// closes.
async function selectItems(page, trigger) {
  await trigger.click();
  const popup = page.locator(".pantry-select-popup[data-open]");
  await popup.waitFor();
  const items = await popup
    .locator(".pantry-select-item")
    .evaluateAll(function readSelectItems(nodes) {
      return nodes.map(function readSelectItem(node) {
        return {
          value: node.getAttribute("data-value"),
          label: node.textContent.replace(/\s+/g, " ").trim(),
          disabled: node.hasAttribute("data-disabled"),
          selected: node.getAttribute("aria-selected") === "true",
        };
      });
    });
  await page.keyboard.press("Escape");
  await popup.waitFor({ state: "hidden" });
  return items;
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
        ) {
          return next.value;
        }
      }
    }
    throw new Error("A Portal Select has no hidden input.");
  });
}

/** The source of the page helpers, for a journey that cannot import them. */
export function pageHelperSource() {
  return [chooseOption, selectItems, selectValue].map(String).join("\n\n");
}
