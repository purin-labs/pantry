// Run after mount-browser-fixture.js in the same Playwright CLI session.
async function verifyMailActionRule(page) {
  await page
    .getByRole("button", { name: "Inbox options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Review Inbox rules", exact: true })
    .click();
  await page.getByRole("heading", { name: "JEV", exact: true }).waitFor();
  const add = page.getByRole("button", {
    name: "Add supplier delay reply rule",
    exact: true,
  });
  await add.focus();
  await page.keyboard.press("Enter");
  const criteria = page.getByRole("textbox", {
    name: "Which supplier delay emails need a reply?",
    exact: true,
  });
  await criteria.fill(
    "Suppliers reporting packaging deliveries delayed beyond the agreed arrival date",
  );
  if (!(await add.isDisabled()))
    throw new Error("A second investigation rule is available");
  await page.getByText(/Cue automatic replies are suspended/).waitFor();
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
  const consent = page.getByRole("checkbox", { name: /^Allow TypeSafe/ });
  await consent.focus();
  await page.keyboard.press("Space");
  await page
    .getByRole("button", { name: "Preview this page", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.getByText(/Supplier delay reply: matched/).waitFor();
  for (const command of await page.evaluate("window.mailOrganizationCommands"))
    if (command.kind === "publish")
      throw new Error("Preview published the action rule");
  await criteria.fill(
    "Suppliers explicitly reporting a packaging delivery delay",
  );
  if (await consent.isChecked())
    throw new Error("Edited action criteria retained consent");
  await consent.check();
  await page
    .getByRole("button", { name: "Publish rules", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { name: "Inbox rules · Active", exact: true })
    .waitFor();
  const commands = await page.evaluate("window.mailOrganizationCommands");
  let publication = null;
  for (const command of commands)
    if (command.kind === "publish") publication = command;
  if (
    publication === null ||
    publication.rules.length !== 1 ||
    publication.rules[0].kind !== "investigate_supplier_delay" ||
    Object.keys(publication.rules[0]).sort().join(",") !==
      "instruction,kind,ruleId"
  )
    throw new Error("Publication carried an arbitrary execution target");
  await page.screenshot({
    path: "output/playwright/mail-action-rule-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await criteria.scrollIntoViewIfNeeded();
  if ((await page.evaluate("document.documentElement.scrollWidth")) !== 320)
    throw new Error("Action rule overflows at 320px");
  const field = await page
    .getByRole("group", { name: "Supplier delay reply 1", exact: true })
    .boundingBox();
  const input = await criteria.boundingBox();
  if (
    field === null ||
    input === null ||
    input.x < field.x ||
    input.x + input.width > field.x + field.width
  )
    throw new Error("Action criteria extend outside their fieldset");
  await page.screenshot({
    path: "output/playwright/mail-action-rule-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Classify this page", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("complementary", { name: "JEV", exact: true })
    .getByText(/These messages are queued for classification/)
    .waitFor();
  // Automatic processing pauses from the Inbox options.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("button", { name: "Inbox options", exact: true })
    .click();
  await page
    .getByRole("menuitemcheckbox", { name: /^Automatic mailbox processing/ })
    .click();
  await page
    .getByRole("heading", { name: "Inbox rules · Paused", exact: true })
    .waitFor();
  console.log(
    "MAIL_ACTION_RULE_BROWSER: keyboard add + consent + preview + publish + historical classify + pause; one supported action with no arbitrary target; criteria edits clear consent; draft-only and Cue-routing disclosure; 320px reflow",
  );
  return { artifact: "MAIL_ACTION_RULE_BROWSER", passed: true };
}
