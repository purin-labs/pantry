// Run after mount-browser-fixture.js in the same Playwright CLI session.
async function verifyMailAssistant(page) {
  async function chooseOption(name) {
    await page
      .getByRole("button", { name: "Inbox options", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  // JEV opens in the drawer, from the options menu or from a case.
  await chooseOption("Review Inbox rules");
  await page.getByRole("heading", { name: "JEV", exact: true }).waitFor();
  if ((await page.evaluate("document.activeElement.textContent")) !== "JEV")
    throw new Error("Opening JEV did not focus the panel");
  const assistant = page.getByRole("region", {
    name: "Inbox assistant",
    exact: true,
  });
  await assistant
    .getByRole("textbox", { name: "Your instruction" })
    .fill("Group supplier delays affecting planned orders");
  await page.getByRole("button", { name: "Close JEV", exact: true }).click();
  if (
    (await page.evaluate(
      "document.activeElement.getAttribute('aria-label')",
    )) !== "Inbox options"
  )
    throw new Error("Closing JEV did not restore focus");
  await chooseOption("Review Inbox rules");
  if (
    (await assistant
      .getByRole("textbox", { name: "Your instruction" })
      .inputValue()) !== ""
  )
    throw new Error("Closing JEV retained a private instruction");
  await assistant
    .getByRole("button", { name: "Supplier delays", exact: true })
    .click();
  if (
    !(await assistant
      .getByRole("button", { name: "Suggest a rule" })
      .isDisabled())
  )
    throw new Error("Processing consent was bypassed");
  await assistant
    .getByRole("checkbox", { name: /^Allow this request/ })
    .focus();
  await page.keyboard.press("Space");
  await assistant.getByRole("button", { name: "Suggest a rule" }).focus();
  await page.keyboard.press("Enter");
  await assistant
    .getByRole("heading", { name: "Suggested criteria" })
    .waitFor();
  if (
    (await page.evaluate("document.activeElement.textContent")) !==
    "Suggested criteria"
  )
    throw new Error("Generated criteria did not receive focus");
  if (
    (await page
      .getByRole("button", { name: "Suppliers", exact: true })
      .count()) !== 0
  )
    throw new Error("A generated rule was published automatically");
  await assistant
    .getByRole("button", { name: "Review in rule editor" })
    .focus();
  await page.keyboard.press("Enter");
  const criteria = page.getByRole("textbox", {
    name: "Which emails belong here?",
  });
  await criteria.waitFor();
  if (
    !(await criteria.evaluate(function focused(element) {
      return document.activeElement === element;
    }))
  )
    throw new Error("Review did not focus the editable criteria");
  if (await page.getByRole("checkbox", { name: /^Allow TypeSafe/ }).isChecked())
    throw new Error("Review reused processing consent");
  await page
    .getByRole("button", { name: "Publish rules", exact: true })
    .click();
  await page
    .getByRole("alert")
    .getByText(
      "Confirm TypeSafe processing before previewing or publishing rules.",
      { exact: true },
    )
    .waitFor();
  if (
    (await page
      .getByRole("button", { name: "Suppliers", exact: true })
      .count()) !== 0
  )
    throw new Error("Publication skipped classification consent");
  await page.getByRole("checkbox", { name: /^Allow TypeSafe/ }).check();
  await page
    .getByRole("button", { name: "Preview this page", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Sample matches", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Publish rules", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Classify this page", exact: true })
    .click();
  // A draft waits in the fixture, so it shows under "Waiting for you".
  await chooseOption("All mail");
  await page
    .getByRole("list", { name: "Email messages", exact: true })
    .getByRole("button", { name: /Packaging delivery delayed/ })
    .click();
  await page
    .getByRole("button", { name: /^Decision details for Suppliers:/ })
    .click();
  // The case's menu opens JEV on the selected decision.
  await page
    .getByRole("button", { name: "Conversation options", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Open JEV/ }).click();
  await page.getByRole("heading", { name: "JEV", exact: true }).waitFor();
  await assistant
    .getByRole("checkbox", { name: /^Allow this request/ })
    .check();
  await assistant
    .getByRole("button", { name: "Explain selected decision" })
    .focus();
  await page.keyboard.press("Enter");
  await assistant
    .getByRole("heading", { name: "Decision explanation" })
    .waitFor();
  await assistant
    .getByText(/JEV's original reasoning was not recorded/)
    .waitFor();
  await page
    .getByRole("heading", { name: "Inbox rules · Active", exact: true })
    .waitFor();
  await assistant.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "output/playwright/mail-assistant-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await assistant.scrollIntoViewIfNeeded();
  if ((await page.evaluate("document.documentElement.scrollWidth")) !== 320)
    throw new Error("Inbox assistance overflows at 320px");
  await page.screenshot({
    path: "output/playwright/mail-assistant-mobile.png",
    fullPage: true,
  });
  // On a phone JEV covers the page. The mailbox control is in reach beside
  // it on a wider window.
  await page.setViewportSize({ width: 1280, height: 900 });
  // A provider response released after navigation cannot repopulate another mailbox.
  await page.evaluate("window.mailAssistantBlock = true");
  await assistant
    .getByRole("textbox", { name: "Your instruction" })
    .fill("A transient instruction that must disappear");
  await assistant.getByRole("button", { name: "Suggest a rule" }).click();
  await assistant.getByRole("status").waitFor();
  await page.getByRole("button", { name: /^Mailbox: / }).click();
  await page
    .getByRole("menuitemradio", { name: "Events · CafeOS", exact: true })
    .click();
  await page.evaluate("window.releaseMailAssistant()");
  await page.getByText("Nothing waits for you.", { exact: true }).waitFor();
  if (
    (await assistant
      .getByRole("textbox", { name: "Your instruction" })
      .inputValue()) !== ""
  )
    throw new Error("Navigation retained the prompt");
  if (
    (await assistant
      .getByRole("heading", { name: "Suggested criteria" })
      .count()) !== 0 ||
    (await assistant
      .getByRole("heading", { name: "Decision explanation" })
      .count()) !== 0
  )
    throw new Error("Navigation retained a response");
  console.log(
    "MAIL_ASSISTANT_BROWSER: keyboard consent + proposal + reviewed publication + reconstructed explanation; focus; 320px reflow; delayed response purged across mailbox navigation",
  );
  return {
    artifact: "MAIL_ASSISTANT_BROWSER",
    passed: true,
    panelFocusVerified: true,
    closeDisposalVerified: true,
  };
}
