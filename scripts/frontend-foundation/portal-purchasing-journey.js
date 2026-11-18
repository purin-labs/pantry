// Run against the local commerce preview. Writes are refused by its transport.
async function reviewPurchasing(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-purchasing-review";
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${origin}/commerce-preview.html?page=suppliers&items=retry`);
  await page.getByRole("button", { name: "Add supplier", exact: true }).click();
  const supplier = page.getByRole("dialog", { name: "Add supplier" });
  await supplier
    .getByText("Inventory items could not be loaded.", { exact: true })
    .waitFor();
  await supplier
    .getByRole("textbox", { name: "Supplier name", exact: true })
    .fill("Aoyama Packaging");
  await supplier
    .getByRole("textbox", { name: "Registered name", exact: true })
    .fill("Aoyama Packaging Co.");
  await supplier
    .getByRole("spinbutton", { name: "Lead time (days)" })
    .fill("5");
  if (
    !(await supplier
      .getByRole("button", { name: "Add supplier", exact: true })
      .isDisabled())
  ) {
    throw new Error("Supplier submission is enabled without inventory items.");
  }
  await supplier
    .getByRole("button", { name: "Try again", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/supplier-item-recovery.png` });
  await supplier
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await supplier
    .getByRole("checkbox", { name: "Paper cups · 12 oz", exact: true })
    .check();
  await supplier
    .getByRole("checkbox", { name: "Lids · 12 oz", exact: true })
    .check();
  await supplier
    .getByRole("textbox", { name: "Purchasing notes", exact: true })
    .fill("Deliver to the rear entrance before 10:00.");
  await page.screenshot({ path: `${artifacts}/supplier-items-narrow.png` });
  await supplier
    .getByRole("button", { name: "Add supplier", exact: true })
    .click();
  await supplier
    .getByRole("alert")
    .filter({ hasText: "Mutations are disabled" })
    .waitFor();
  if (
    (await supplier
      .getByRole("textbox", { name: "Supplier name", exact: true })
      .inputValue()) !== "Aoyama Packaging"
  ) {
    throw new Error("Supplier name was lost after failure.");
  }
  if (
    !(await supplier
      .getByRole("checkbox", { name: "Lids · 12 oz", exact: true })
      .isChecked())
  ) {
    throw new Error("Selected inventory items were lost after failure.");
  }
  const errorVisible = await page.evaluate(
    "document.activeElement?.getAttribute('role') === 'alert' && document.activeElement.getBoundingClientRect().top >= 0 && document.activeElement.getBoundingClientRect().bottom <= innerHeight",
  );
  if (!errorVisible) throw new Error("Supplier error was not focused in view.");
  await page.screenshot({ path: `${artifacts}/supplier-failed-narrow.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await supplier
    .getByRole("heading", { name: "Add supplier", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/supplier-wide.png` });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await page.screenshot({ path: `${artifacts}/supplier-dark.png` });
  await page.keyboard.press("Escape");
  if (await supplier.isVisible())
    throw new Error("Escape did not close the supplier dialog.");

  await page.goto(`${origin}/commerce-preview.html?page=suppliers`);
  await page.setViewportSize({ width: 320, height: 800 });
  const card = page.locator(".commerce-board-card").filter({
    has: page.getByRole("heading", {
      name: "8oz takeaway cups",
      exact: true,
    }),
  });
  await card
    .getByRole("button", { name: "Order 8oz takeaway cups", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Order 8oz takeaway cups",
    exact: true,
  });
  const delivery = drawer.getByLabel("Expected delivery", { exact: true });
  const displayedDelivery = await delivery.inputValue();
  // The UI must preserve the instant when an operator saves an unchanged time.
  const deliveryInstant = await page.evaluate(
    `new Date(${JSON.stringify(displayedDelivery)}).toISOString()`,
  );
  if (deliveryInstant !== "2026-09-03T09:00:00.000Z") {
    throw new Error(
      `The delivery field changed the instant to ${deliveryInstant}.`,
    );
  }
  await drawer
    .getByRole("textbox", { name: "Who is ordering", exact: true })
    .fill("Mika Tanaka");
  await drawer
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Confirm the receiving entrance before dispatch.");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await drawer
    .getByText("Mutations are disabled in this preview.", { exact: true })
    .waitFor();
  if ((await delivery.inputValue()) !== displayedDelivery)
    throw new Error("Failure changed the requested delivery time.");
  if (
    (await drawer
      .getByRole("textbox", { name: "Who is ordering", exact: true })
      .inputValue()) !== "Mika Tanaka"
  ) {
    throw new Error("Failure lost the purchase request edits.");
  }
  await page.screenshot({ path: `${artifacts}/purchase-request-failed.png` });
  const fieldBounds = await page.evaluate(
    "Array.from(document.querySelectorAll('.commerce-order-drawer[open] input, .commerce-order-drawer[open] textarea')).every(e => e.getBoundingClientRect().width <= e.parentElement.getBoundingClientRect().width + 1 && e.getBoundingClientRect().height >= 44)",
  );
  if (!fieldBounds)
    throw new Error(
      "A purchase request field exceeds its drawer or is too short.",
    );
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await chooseOption(
    page,
    card.getByRole("combobox", { name: "Move 8oz takeaway cups to lane" }),
    { label: "Expected" },
  );
  await page
    .getByRole("button", { name: "Retry change", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Retry change", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/board-move-failure.png` });
  await page
    .getByRole("button", { name: "Discard change", exact: true })
    .click();
  if (
    (await selectValue(
      card.getByRole("combobox", { name: "Move 8oz takeaway cups to lane" }),
    )) !== "requested"
  ) {
    throw new Error("A refused board move changed the visible lane.");
  }
  await page.getByText("Display options", { exact: true }).click();
  const display = page.locator(".commerce-display-options");
  await display.getByRole("checkbox").first().click();
  await display
    .getByRole("button", { name: "Retry view update", exact: true })
    .waitFor();
  await display.screenshot({ path: `${artifacts}/display-options-failed.png` });
  await display
    .getByRole("button", { name: "Retry view update", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${artifacts}/display-options-failure-actions.png`,
  });
  await display
    .getByRole("button", { name: "Discard view update", exact: true })
    .click();

  await page.goto(`${origin}/commerce-preview.html?page=suppliers&items=empty`);
  await page.getByRole("button", { name: "Add supplier", exact: true }).click();
  await supplier
    .getByText("Add inventory items before you add a supplier.", {
      exact: true,
    })
    .waitFor();
  await supplier
    .getByRole("button", { name: "Add supplier", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/supplier-empty.png` });
  if (
    !(await supplier
      .getByRole("button", { name: "Add supplier", exact: true })
      .isDisabled())
  )
    throw new Error("Empty inventory permits a supplier submission.");

  await page.goto(
    `${origin}/commerce-preview.html?page=orders&resource=ord_1041`,
  );
  const cancelOrder = page.getByRole("button", {
    name: "Cancel order",
    exact: true,
  });
  await cancelOrder.click();
  const cancellation = page.getByRole("dialog", {
    name: "Cancel order",
    exact: true,
  });
  await cancellation
    .getByText("Order #1041 · Aiko Sato", { exact: true })
    .waitFor();
  await chooseOption(
    page,
    cancellation.getByRole("combobox", { name: "Reason", exact: true }),
    { value: "inventory_unavailable" },
  );
  await page.screenshot({ path: `${artifacts}/cancellation-narrow.png` });
  await page.keyboard.press("Escape");
  const restored = await page.evaluate(
    "document.activeElement?.textContent?.trim() === 'Cancel order'",
  );
  if (!restored)
    throw new Error("Cancellation did not restore its trigger focus.");
  await cancelOrder.click();
  await cancellation
    .getByRole("button", { name: "Review cancellation", exact: true })
    .click();
  await cancellation.getByRole("alert").waitFor();
  if (
    (await selectValue(
      cancellation.getByRole("combobox", { name: "Reason", exact: true }),
    )) !== "inventory_unavailable"
  )
    throw new Error("Cancellation failure lost the reason.");
  await page.screenshot({ path: `${artifacts}/cancellation-failed.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await page.screenshot({ path: `${artifacts}/cancellation-dark.png` });

  await page.goto(`${origin}/commerce-preview.html?page=suppliers&role=viewer`);
  await page
    .getByText("Your role can view purchasing but cannot change it.", {
      exact: true,
    })
    .waitFor();
  if (
    await page
      .getByRole("button", { name: "Add supplier", exact: true })
      .count()
  )
    throw new Error("Viewer can create suppliers.");
  await page
    .getByText(/^Ordered by Pta/)
    .first()
    .waitFor();
  if (await page.getByRole("button", { name: /^Order / }).count())
    throw new Error("Viewer can edit purchase requests.");
  await page.screenshot({ path: `${artifacts}/purchasing-viewer.png` });
  await page.goto(
    `${origin}/commerce-preview.html?page=orders&resource=ord_1041&role=viewer`,
  );
  await page
    .getByRole("heading", { name: "Order #1041 · Aiko Sato", exact: true })
    .waitFor();
  if (
    await page
      .getByRole("button", { name: "Cancel order", exact: true })
      .count()
  )
    throw new Error("Viewer can propose order cancellation.");
  await page.screenshot({ path: `${artifacts}/order-viewer.png` });
  return {
    status: "passed",
    supplierReadRecovery: "passed",
    supplierFailurePreservesDraft: "passed",
    deliveryInstant,
    purchaseFailurePreservesDraft: "passed",
    boardAndViewFailure: "passed",
    cancellationFailurePreservesReason: "passed",
    viewer: "passed",
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
