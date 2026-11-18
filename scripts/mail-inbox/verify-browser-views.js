// Run after mount-browser-fixture.js in the same Playwright CLI session.
async function verifyMailViews(page) {
  async function chooseMenuItem(name) {
    await page
      .getByRole("button", { name: "Inbox options", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
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

  // A draft waits in the fixture, so it shows under "Waiting for you". The
  // classified views belong to All mail and show when a rule exists.
  await page
    .getByRole("heading", { name: "Waiting for you", exact: true })
    .waitFor();
  await chooseMenuItem("All mail");
  const views = page.getByRole("group", { name: "Inbox views", exact: true });
  const firstRow = page
    .getByRole("list", { name: "Email messages", exact: true })
    .getByRole("button", { name: /Packaging delivery delayed/ });
  await firstRow.waitFor();
  if (
    (await views.count()) !== 0 ||
    /Unclassified|No current classification/.test(await firstRow.innerText())
  )
    throw new Error("Mail without a rule shows views or a classification");
  // The rules open in the drawer, beside All mail.
  await chooseMenuItem("Review Inbox rules");
  await page.getByRole("heading", { name: "JEV", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add category", exact: true }).click();
  await page
    .getByRole("button", { name: "Add priority rule", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Category name", exact: true })
    .fill("Suppliers");
  await page
    .getByRole("textbox", { name: "Which emails belong here?", exact: true })
    .fill("Emails from suppliers about deliveries");
  await page
    .getByRole("textbox", { name: "Which emails are important?", exact: true })
    .fill("A supplier explicitly reports a delivery delay");
  await page.getByRole("checkbox", { name: /^Allow TypeSafe/ }).check();
  await page
    .getByRole("button", { name: "Publish rules", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Classify this page", exact: true })
    .click();
  await firstRow.getByText("Suppliers · Important", { exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "Category name", exact: true })
    .fill("Unsaved supplier edit");
  await views.getByRole("button", { name: "Suppliers", exact: true }).focus();
  await page.keyboard.press("Enter");
  if (
    !(await page.getByRole("searchbox", { name: "Search mail" }).isDisabled())
  )
    throw new Error("Classified views must direct search to All");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  if (
    (await page
      .getByRole("textbox", { name: "Category name", exact: true })
      .inputValue()) !== "Unsaved supplier edit"
  )
    throw new Error("Paging discarded unpublished criteria");
  // A row opens its case in the drawer, in place of the rules.
  await page
    .getByRole("button", { name: /Bakery ingredients delivery/ })
    .click();
  const conversation = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  await conversation.waitFor();
  if (
    (await page.getByRole("heading", { name: "JEV", exact: true }).count()) !==
    0
  )
    throw new Error("The rules stayed over the case");
  // The rule results of a thread show below its messages.
  await conversation
    .getByRole("heading", {
      name: "Classification and corrections",
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", { name: /^Decision details for Suppliers:/ })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByText(
      "Email changed since classification. This result may be out of date.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("region", { name: "Decision details", exact: true })
    .getByText("Criterion:", { exact: false })
    .waitFor();
  await page.screenshot({
    path: "output/playwright/mail-classified-views-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page
    .getByRole("region", { name: "Decision details", exact: true })
    .scrollIntoViewIfNeeded();
  const width = await page.evaluate("document.documentElement.scrollWidth");
  if (width !== 320 || (await page.locator(".mail-inbox img").count()) !== 0)
    throw new Error("Inbox overflowed or rendered remote message images");
  await page.screenshot({
    path: "output/playwright/mail-classified-views-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Suppliers · JEV result", exact: true }),
    { value: "not_matched" },
  );
  // The list reads its page again and takes focus. The case stays open.
  await page.getByRole("heading", { name: "All mail", exact: true }).waitFor();
  await page.waitForFunction(
    "document.activeElement?.textContent === 'All mail'",
  );
  await page
    .getByRole("list", { name: "Email messages", exact: true })
    .getByRole("button", { name: /Packaging delivery delayed/ })
    .waitFor();
  if (
    (await page
      .getByRole("region", { name: "Decision details", exact: true })
      .count()) !== 0
  )
    throw new Error("Navigation retained transient decision details");
  await views.getByRole("button", { name: "All", exact: true }).click();
  if (await page.getByRole("searchbox", { name: "Search mail" }).isDisabled())
    throw new Error("All must restore Gmail search");
  await page
    .getByRole("list", { name: "Email messages", exact: true })
    .getByRole("button", { name: /Packaging delivery delayed/ })
    .click();
  await page
    .getByRole("button", { name: /^Decision details for Suppliers:/ })
    .click();
  await page
    .getByText("Email matches the evidence used for classification.", {
      exact: true,
    })
    .waitFor();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Priority · JEV result", exact: true }),
    { value: "not_matched" },
  );
  await page
    .getByRole("combobox", { name: "Priority · Your correction", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: /^Decision details for Priority:/ })
    .click();
  await page
    .getByRole("region", { name: "Decision details", exact: true })
    .getByText(/Your correction: not matched/)
    .waitFor();
  // Another mailbox shows its own list, and nothing of the first one.
  await page.getByRole("button", { name: /^Mailbox: / }).click();
  await page
    .getByRole("menuitemradio", { name: "Events · CafeOS", exact: true })
    .click();
  await page.getByText("Nothing waits for you.", { exact: true }).waitFor();
  if (
    (await page
      .getByRole("region", { name: "Decision details", exact: true })
      .count()) !== 0 ||
    (await conversation.count()) !== 0
  )
    throw new Error("Mailbox change retained decision details or a case");
  return { artifact: "MAIL_CLASSIFIED_VIEWS_BROWSER", passed: true };
}
