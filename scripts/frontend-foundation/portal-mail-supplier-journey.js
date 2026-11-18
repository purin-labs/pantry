// Run after the Inbox fixture. Uses local supplier read and revision faults.
async function reviewMailSupplier(page) {
  const artifacts = "output/playwright/ui-file-access-review";
  await page.setViewportSize({ width: 320, height: 900 });
  await page
    .getByRole("list", { name: "Conversations that need you", exact: true })
    .getByRole("button", { name: /Packaging delivery delayed/ })
    .click();
  const conversation = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  const supplier = conversation.getByRole("region", {
    name: "Supplier",
    exact: true,
  });
  await supplier
    .getByText("Not linked to a supplier.", { exact: true })
    .waitFor();
  await page.evaluate("window.mailSupplierReadDelay = true");
  await supplier
    .getByRole("button", { name: "Link sender to a supplier", exact: true })
    .click();
  await supplier.getByText("Loading suppliers…", { exact: true }).waitFor();
  await supplier.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(
    "document.activeElement?.textContent === 'Link sender to a supplier'",
  );
  await page.evaluate(
    "window.mailSupplierReadDelay = false; window.releaseMailSuppliers()",
  );
  await page.waitForTimeout(250);
  if (await supplier.getByRole("combobox").count())
    throw new Error("A cancelled supplier read reopened its choice.");
  await supplier.screenshot({
    path: `${artifacts}/supplier-read-cancelled.png`,
  });
  await page.evaluate("window.mailSupplierReadFailure = true");
  await supplier
    .getByRole("button", { name: "Link sender to a supplier", exact: true })
    .click();
  await supplier.getByRole("alert").waitFor();
  await page.waitForFunction(
    "document.activeElement?.getAttribute('role') === 'alert'",
  );
  await supplier.screenshot({ path: `${artifacts}/supplier-read-failed.png` });
  await page.evaluate("window.mailSupplierReadFailure = false");
  await supplier
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  const choice = supplier.getByRole("combobox", {
    name: "Supplier",
    exact: true,
  });
  await chooseOption(page, choice, { value: "supplier_packaging" });
  await page.evaluate(
    "window.mailSenderLink = { supplier: null, revision: 1 }",
  );
  await supplier
    .getByRole("button", { name: "Link sender", exact: true })
    .click();
  await supplier.getByRole("alert").waitFor();
  if ((await selectValue(choice)) !== "supplier_packaging")
    throw new Error("A refused link change lost the supplier choice.");
  await page.waitForFunction(
    "document.activeElement?.getAttribute('role') === 'alert'",
  );
  await supplier.screenshot({ path: `${artifacts}/supplier-save-failed.png` });
  await supplier.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(
    "document.activeElement?.textContent === 'Link sender to a supplier'",
  );
  await page.evaluate("window.mailNoSuppliers = true");
  await supplier
    .getByRole("button", { name: "Link sender to a supplier", exact: true })
    .click();
  await supplier.getByText(/^No suppliers exist yet\./).waitFor();
  await supplier.screenshot({ path: `${artifacts}/supplier-empty-narrow.png` });
  await supplier.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(
    "window.mailNoSuppliers = false; window.mailPurchasingOff = true",
  );
  await supplier
    .getByRole("button", { name: "Link sender to a supplier", exact: true })
    .click();
  await supplier
    .getByRole("link", { name: "Set up purchasing", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await supplier.screenshot({ path: `${artifacts}/supplier-setup-dark.png` });
  return {
    status: "passed",
    cancelledReadStaysClosed: "passed",
    readFailureRecovery: "passed",
    failedChangePreservesChoice: "passed",
    cancelAndErrorFocus: "passed",
    emptyAndSetup: "reviewed",
    artifacts,
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
}
