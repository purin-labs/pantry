// Run after the Plan 21 browser fixture in the same Playwright CLI session.
// This journey changes only local sample proposals and editor drafts.
async function verifyConfigurationSurfaces(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-remaining-review";
  const checks = [];
  await page.context().addCookies([
    {
      name: "satyr_control_csrf",
      value: "csrf_configuration_preview",
      url: origin,
      sameSite: "Lax",
    },
  ]);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(
    `${origin}/portal/cafe-browser-lab/main/terminals?p21_auth=1`,
  );
  const retirement = page.getByRole("button", {
    name: "Stop taking payments",
    exact: true,
  });
  await retirement.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Retire counter",
    exact: true,
  });
  await page.waitForFunction(
    "document.activeElement?.textContent === 'Keep it running'",
  );
  const bounds = await dialog.boundingBox();
  if (
    bounds === null ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > 320 ||
    bounds.y + bounds.height > 800
  ) {
    throw new Error("The retirement dialog extends outside the viewport.");
  }
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    if (
      !(await page.evaluate(
        "document.activeElement === document.body || document.querySelector('dialog')?.contains(document.activeElement)",
      ))
    ) {
      throw new Error("Keyboard focus escaped the retirement dialog.");
    }
  }
  await page.screenshot({
    path: `${artifacts}/counter-retire-narrow-after.png`,
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(
    "document.activeElement?.classList.contains('terminal-row-action')",
  );
  await page.keyboard.press("Enter");
  await dialog
    .getByRole("button", { name: "Keep it running", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  await page.getByText("Ready", { exact: true }).waitFor();
  if (
    await page.evaluate("document.documentElement.scrollWidth > innerWidth")
  ) {
    throw new Error(
      "The counter page overflows after retirement cancellation.",
    );
  }
  await page.getByText("Terminal setup", { exact: true }).click();
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Sandbox test device", exact: true }),
    { label: "Buyer cancels payment" },
  );
  await page.locator(".terminal-settings").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${artifacts}/counter-setup-narrow-after.png`,
  });
  checks.push(
    "Counter retirement fits at 320px, traps focus, closes with Escape, restores focus, and preserves the ready counter after cancellation.",
  );

  await page.goto(`${origin}/agents-preview.html?scenario=history-retry`);
  await page
    .getByRole("button", { name: "Configure Urk", exact: true })
    .click();
  const instructions = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await instructions.fill(
    "Draft: prepare tomorrow’s stock report for the owner.",
  );
  await page.getByText("Revision history", { exact: true }).first().click();
  await page
    .getByText("Revision history could not be loaded.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByRole("heading", { name: "Revision 2 · current", exact: true })
    .waitFor();
  if (
    (await instructions.inputValue()) !==
    "Draft: prepare tomorrow’s stock report for the owner."
  ) {
    throw new Error("History recovery replaced an unsaved instruction draft.");
  }
  const oldRevision = page
    .locator(".agent-revision")
    .filter({ hasText: "Revision 1" });
  await oldRevision.getByText("Show text", { exact: true }).click();
  await oldRevision
    .getByText(
      "Review café stock each morning. Ask the owner before any change.",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: `${artifacts}/agent-history-narrow-after.png`,
  });
  await oldRevision
    .getByRole("button", { name: "Load into editor: revision 1", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    "document.activeElement?.getAttribute('name') === 'instructions'",
  );
  if (
    (await instructions.inputValue()) !==
    "Review café stock each morning. Ask the owner before any change."
  ) {
    throw new Error("The selected revision did not reach the editor.");
  }
  await page
    .getByText(
      "Published version 2. Publishing does not change a running agent.",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({ path: `${artifacts}/agent-restored-draft.png` });
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  const triggerDrawer = page.getByRole("dialog", {
    name: "Add trigger",
    exact: true,
  });
  // The drawer asks for the kind of trigger first, then shows its form only.
  if (
    (await triggerDrawer
      .getByRole("combobox", { name: "Cadence", exact: true })
      .count()) !== 0
  ) {
    throw new Error("The trigger drawer shows a form before a choice.");
  }
  await triggerDrawer
    .getByRole("radio", { name: "On a schedule", exact: true })
    .check();
  await chooseOption(
    page,
    triggerDrawer.getByRole("combobox", { name: "Cadence", exact: true }),
    { value: "weekly" },
  );
  await chooseOption(
    page,
    triggerDrawer.getByRole("combobox", { name: "Day of week", exact: true }),
    { value: "fri" },
  );
  await triggerDrawer.getByLabel("Time of day", { exact: true }).fill("08:30");
  await triggerDrawer
    .getByLabel("Timezone", { exact: true })
    .fill("Asia/Tokyo");
  if (
    (await triggerDrawer
      .getByRole("combobox", { name: "Signal", exact: true })
      .count()) !== 0
  ) {
    throw new Error("The schedule choice also shows the signal form.");
  }
  await triggerDrawer
    .getByRole("button", { name: "Add schedule", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/agent-weekly-schedule.png` });
  if (
    await page.evaluate("document.documentElement.scrollWidth > innerWidth")
  ) {
    throw new Error("Agent configuration overflows the viewport.");
  }
  checks.push(
    "Agent history recovers from a failed read without losing a draft; a selected revision loads into the focused editor without publication; the trigger drawer shows only the schedule form after that choice, and its weekly fields remain usable.",
  );

  // The Skills library is the Skills view of the Knowledge page.
  await page.goto(
    `${origin}/agents-preview.html?scenario=history-retry&view=skills`,
  );
  const createSkill = page.getByRole("button", {
    name: "Create skill",
    exact: true,
  });
  await createSkill.focus();
  await page.keyboard.press("Enter");
  const skillDialog = page.getByRole("dialog", {
    name: "New skill",
    exact: true,
  });
  const closeBounds = await skillDialog
    .getByRole("button", { name: "Close", exact: true })
    .boundingBox();
  if (
    closeBounds === null ||
    closeBounds.width < 44 ||
    closeBounds.height < 44
  ) {
    throw new Error(
      "The skill dialog close control shrinks below its touch size.",
    );
  }
  await page.screenshot({ path: `${artifacts}/skill-create-narrow-after.png` });
  await page.keyboard.press("Escape");
  await skillDialog.waitFor({ state: "detached" });
  await page.waitForFunction(
    "document.activeElement?.textContent?.trim() === 'Create skill'",
  );
  checks.push(
    "The skill creation dialog keeps a full-size close control at 320px and restores its keyboard trigger.",
  );

  await page.goto(
    `${origin}/portal/cafe-browser-lab/main?p21_auth=1&p21_provider=1`,
  );
  await page
    .getByRole("button", { name: "Review change", exact: true })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    "document.activeElement?.matches('.action-status-heading h2')",
  );
  const review = page.locator(".commerce-action-status");
  for (const name of ["Product", "Variant", "Offer", "Sales channel"]) {
    await review
      .locator(".action-change-facts dt")
      .filter({ hasText: name })
      .waitFor();
  }
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${artifacts}/approval-narrow-after.png` });
  await review
    .getByRole("button", { name: "Reject change", exact: true })
    .click();
  await review
    .getByRole("button", { name: "Keep proposal", exact: true })
    .click();
  await review
    .getByRole("button", { name: "Approve and apply", exact: true })
    .waitFor();
  await review
    .getByRole("button", { name: "Approve and apply", exact: true })
    .click();
  await review
    .getByRole("button", { name: "Apply change", exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/approval-authorized-after.png` });
  await page
    .getByRole("list", { name: "Approvals needing a decision" })
    .getByRole("listitem")
    .filter({ hasText: "Needs approval" })
    .getByRole("button", { name: "Review change", exact: true })
    .click();
  await page.waitForFunction(
    "document.activeElement?.matches('.action-status-heading h2')",
  );
  await review
    .getByRole("button", { name: "Reject change", exact: true })
    .click();
  await review
    .getByRole("button", { name: "Reject change", exact: true })
    .click();
  await review.getByText("Change declined", { exact: true }).waitFor();
  if (
    (await review
      .getByRole("button", { name: "Apply change", exact: true })
      .count()) !== 0
  ) {
    throw new Error("A rejected proposal offers execution.");
  }
  await page.screenshot({ path: `${artifacts}/approval-declined-after.png` });
  checks.push(
    "Catalog review receives keyboard focus and shows its target before approval; cancellation preserves the proposal; approval and rejection retain distinct execution controls.",
  );
  return { status: "passed", checks, artifacts };

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
}
