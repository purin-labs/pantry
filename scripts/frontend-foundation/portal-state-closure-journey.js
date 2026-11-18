// Browser behavior checks after the state sweep. Uses local preview data only.
async function verifyRemainingPortalStates(page) {
  const origin = new URL(page.url()).origin;
  const directory = "output/playwright/ui-state-closure";
  const checks = [];
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(
    `${origin}/chat-preview.html?scenario=projects&conversation=conv_00000000-0000-0000-0000-000000000001`,
  );
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByRole("button", { name: "Open history", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Manage access to Autumn menu launch",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Enter");
  const sharing = page.locator(".project-sharing-dialog[open]");
  await chooseOption(
    page,
    sharing.getByRole("combobox", { name: "Person", exact: true }),
    { label: "Aiko · Pastry operations" },
  );
  await chooseOption(
    page,
    sharing.getByRole("combobox", { name: "Access", exact: true }),
    { value: "viewer" },
  );
  await page.screenshot({ path: `${directory}/project-sharing-selected.png` });
  await page.keyboard.press("Escape");
  await sharing.waitFor({ state: "hidden" });
  await page.waitForFunction(
    "document.querySelector('#chat-history')?.hasAttribute('open') && document.activeElement?.getAttribute('aria-label') === 'Manage access to Autumn menu launch'",
  );
  await page
    .getByRole("button", { name: "Edit Autumn menu launch", exact: true })
    .click();
  const editor = page.locator(".project-dialog[open]");
  await editor
    .getByRole("textbox", { name: "Brief", exact: true })
    .fill("Draft brief that must not be saved.");
  await editor
    .getByRole("searchbox", { name: "Workspace references", exact: true })
    .fill("missing reference");
  await editor
    .getByText("No matching references. Try another search.", { exact: true })
    .waitFor();
  await page.screenshot({ path: `${directory}/project-reference-empty.png` });
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit Autumn menu launch", exact: true })
    .click();
  if (
    (await editor
      .getByRole("textbox", { name: "Brief", exact: true })
      .inputValue()) !== "Plan the autumn range and its packaging."
  ) {
    throw new Error("Cancelling a project editor saved the draft.");
  }
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Delete Autumn menu launch", exact: true })
    .click();
  await page.screenshot({
    path: `${directory}/project-delete-confirmation.png`,
  });
  await page.keyboard.press("Escape");
  await page.locator("#chat-history[open]").waitFor();
  await page.screenshot({
    path: `${directory}/history-preserved-after-cancel.png`,
  });
  await page
    .getByRole("button", {
      name: "Actions for Review the spring menu",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page
    .getByRole("heading", { name: "Rename chat", exact: true })
    .waitFor();
  await page.screenshot({ path: `${directory}/chat-menu-rename-verified.png` });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", {
      name: "Actions for Review the spring menu",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Autumn menu launch", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Chat visibility", exact: true })
    .waitFor();
  await page
    .getByText("Members can see existing history and attachments.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: `${directory}/chat-menu-visibility-verified.png`,
  });
  await page.keyboard.press("Escape");
  await page.locator("#chat-history[open]").waitFor();
  checks.push(
    "Project dialogs retain the parent history; pointer selection from its action menus opens rename and visibility review.",
  );

  await page.goto(
    `${origin}/brain-preview.html?view=evals&eval=eval_preview_invoice`,
  );
  await page
    .getByRole("button", { name: "Edit scenarios first", exact: true })
    .click();
  const scenarios = page.getByRole("form", { name: "Scenarios of this eval" });
  await scenarios
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Invoice request for accounts");
  await scenarios
    .getByRole("button", { name: "Add an expected result", exact: true })
    .click();
  await chooseOption(
    page,
    scenarios.getByRole("combobox", {
      name: "Kind of expected result 2",
      exact: true,
    }),
    { label: "The reply includes" },
  );
  await scenarios
    .getByRole("button", { name: "Save for review", exact: true })
    .click();
  if ((await scenarios.count()) !== 1)
    throw new Error("An empty expected result was saved.");
  await page.screenshot({ path: `${directory}/eval-validation.png` });
  await scenarios
    .getByRole("textbox", { name: "Expected result 2", exact: true })
    .fill("accounts");
  await scenarios
    .getByRole("button", { name: "Save for review", exact: true })
    .click();
  await page
    .getByText(
      "Saved for review. Runs keep the reviewed scenarios until someone accepts the change.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "Accept these scenarios", exact: true })
    .waitFor();
  await page
    .getByText("Invoice request for accounts", { exact: true })
    .waitFor();
  await page.screenshot({ path: `${directory}/eval-saved-candidate.png` });
  checks.push(
    "An empty evaluation criterion is refused; a valid edit remains a candidate that requires acceptance.",
  );

  await page.goto(
    `${origin}/access-preview.html?scenario=populated&view=data_flow`,
  );
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Case", exact: true }),
    { label: "Supplier price question" },
  );
  const related = page.locator(".access35-related-cases");
  await related
    .getByRole("button", { name: "Reload Related Cases", exact: true })
    .waitFor({ state: "visible" });
  await related
    .getByRole("button", { name: "Reload Related Cases", exact: true })
    .click();
  await related.scrollIntoViewIfNeeded();
  const selectBounds = await related
    .getByRole("combobox", { name: "Case", exact: true })
    .boundingBox();
  if (
    selectBounds === null ||
    selectBounds.height < 44 ||
    selectBounds.x < 0 ||
    selectBounds.x + selectBounds.width > 320
  ) {
    throw new Error(
      "The related Case selector does not fit its narrow layout.",
    );
  }
  await page.screenshot({ path: `${directory}/related-cases-after.png` });
  checks.push(
    "Related Cases can be selected and reloaded through the narrow form.",
  );

  await page.goto(`${origin}/brain-preview.html?scenario=viewer`);
  await page
    .getByRole("heading", {
      name: "4 items await review by an owner or admin.",
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: `${directory}/brain-viewer-after.png` });
  await page.goto(
    `${origin}/commerce-preview.html?page=commerce&scenario=empty`,
  );
  await page.locator(".commerce-count-grid").waitFor();
  if ((await page.locator(".commerce-count-grid").innerText()).includes("3"))
    throw new Error(
      "The empty commerce fixture still contains populated counts.",
    );
  await page.screenshot({ path: `${directory}/commerce-empty-after.png` });
  checks.push(
    "Viewer copy names the review authority; the empty commerce fixture contains zero counts.",
  );
  await page.goto(
    `${origin}/commerce-preview.html?page=checkout&scenario=fresh`,
  );
  await page
    .getByRole("button", { name: "Edit settings", exact: true })
    .click();
  const profileName = page.getByRole("textbox", {
    name: "Profile name",
    exact: true,
  });
  await profileName.fill("Cafe pickup — saved draft retry");
  await page
    .getByRole("button", { name: "Save checkout settings", exact: true })
    .click();
  const saveError = page
    .getByRole("alert")
    .filter({ hasText: "Mutations are disabled in this preview." });
  await saveError.waitFor();
  await page.waitForFunction(
    "document.activeElement?.classList.contains('checkout-profile-error')",
  );
  const errorBounds = await saveError.boundingBox();
  if (
    errorBounds === null ||
    errorBounds.y < 0 ||
    errorBounds.y + errorBounds.height > 800
  ) {
    throw new Error("The Checkout save error is outside the viewport.");
  }
  if ((await profileName.inputValue()) !== "Cafe pickup — saved draft retry") {
    throw new Error("A failed Checkout save lost the draft.");
  }
  await page.screenshot({
    path: `${directory}/checkout-save-error-verified.png`,
  });
  checks.push(
    "A refused Checkout save focuses a visible error and preserves the draft for retry.",
  );
  return { status: "passed", checks, directory };

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
