// Local Access fixtures; no provider authorization or live grants.
async function reviewFilePickers(page) {
  const origin = new URL(page.url()).origin;
  const base = `${origin}/access-preview.html?scenario=populated&view=access&setup=files&provider=dropbox`;
  const artifacts = "output/playwright/ui-file-access-review";
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${base}&filePicker=delayed`);
  const dialog = page.getByRole("dialog");
  const account = dialog.getByRole("combobox", {
    name: "Connected file account",
    exact: true,
  });
  const add = dialog.getByRole("button", {
    name: "Add files to Pantry",
    exact: true,
  });
  await account.waitFor();
  if (!(await add.isDisabled()))
    throw new Error("Empty file selection permits a grant.");
  await dialog
    .getByRole("button", { name: "Search Dropbox", exact: true })
    .click();
  await chooseOption(page, account, { value: "intacc_dropbox_office" });
  await page.waitForTimeout(1800);
  if (
    await dialog
      .getByRole("button", { name: "/Kitchen/Recipes", exact: true })
      .count()
  )
    throw new Error("A prior account's search populated the selected account.");
  await dialog
    .getByRole("searchbox", { name: "Find a folder or file", exact: true })
    .press("Enter");
  await dialog
    .getByRole("button", { name: "/Office/Contracts", exact: true })
    .click();
  await dialog
    .getByText("Selected folder: /Office/Contracts", { exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/account-switch-after.png` });
  await chooseOption(page, account, { value: "intacc_dropbox_kitchen" });
  if (!(await add.isDisabled()))
    throw new Error("Account change retained the previous file selection.");

  await page.goto(`${base}&filePicker=page-retry&grantFailure=stale`);
  await dialog
    .getByRole("button", { name: "Search Dropbox", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "/Kitchen/Recipes", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Load more Dropbox results", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "The file provider could not be reached." })
    .waitFor();
  await dialog
    .getByRole("button", { name: "/Kitchen/Recipes", exact: true })
    .waitFor();
  await page.waitForFunction(
    "document.activeElement?.getAttribute('role') === 'alert'",
  );
  await page.screenshot({ path: `${artifacts}/pagination-failed.png` });
  await dialog
    .getByRole("button", { name: "Load more Dropbox results", exact: true })
    .click();
  const longFile = dialog.getByRole("button", {
    name: "/Kitchen/Recipes/Autumn financier production notes and ingredient specifications.pdf",
    exact: true,
  });
  await longFile.waitFor();
  if (
    (await dialog
      .getByRole("list", { name: "Dropbox search results", exact: true })
      .getByRole("listitem")
      .count()) !== 2
  )
    throw new Error("Pagination lost or duplicated earlier results.");
  await longFile.click();
  await page.screenshot({ path: `${artifacts}/file-selected-narrow.png` });
  const query = dialog.getByRole("searchbox", {
    name: "Find a folder or file",
    exact: true,
  });
  await query.fill("recipes");
  await query.press("Enter");
  await dialog
    .getByRole("button", { name: "/Kitchen/Recipes", exact: true })
    .waitFor();
  if (await dialog.getByRole("alert").count())
    throw new Error("Enter in the search field submitted the grant.");
  await add.click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "connector account changed" })
    .waitFor();
  await dialog.getByText(/^Selected file: .*Autumn financier/).waitFor();
  await page.screenshot({ path: `${artifacts}/file-grant-refused.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await page.screenshot({ path: `${artifacts}/file-grant-dark.png` });

  await page.setViewportSize({ width: 320, height: 900 });
  for (const mode of ["empty", "retry"]) {
    await page.goto(`${base}&filePicker=${mode}`);
    await dialog
      .getByRole("button", { name: "Search Dropbox", exact: true })
      .click();
    if (mode === "empty")
      await dialog
        .getByText(
          "No files or folders match. Try another folder path or search.",
          { exact: true },
        )
        .waitFor();
    else {
      await dialog.getByRole("alert").waitFor();
      await dialog
        .getByRole("button", { name: "Search Dropbox", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "/Kitchen/Recipes", exact: true })
        .waitFor();
    }
    await page.screenshot({ path: `${artifacts}/dropbox-${mode}.png` });
  }
  for (const outcome of ["cancel", "failed", "selected"]) {
    await page.goto(
      `${origin}/access-preview.html?scenario=populated&view=access&setup=files&provider=google_drive&drive=${outcome}`,
    );
    const choose = dialog.getByRole("button", {
      name: "Choose a Google Drive file",
      exact: true,
    });
    await choose.click();
    await dialog.waitFor({ state: "hidden" });
    await dialog.waitFor({ state: "visible" });
    await choose.waitFor({ state: "visible" });
    await page.waitForFunction(
      "document.activeElement?.textContent?.trim() === 'Choose a Google Drive file'",
    );
    if (outcome === "selected")
      await dialog
        .getByText("Selected file: Menu photos", { exact: true })
        .waitFor();
    else if (!(await add.isDisabled()))
      throw new Error(
        `${outcome} Google picker enabled a grant without a file.`,
      );
    if (outcome === "failed") await dialog.getByRole("alert").waitFor();
    await page.screenshot({ path: `${artifacts}/drive-${outcome}.png` });
  }
  return {
    status: "passed",
    accountIsolation: "passed",
    paginationFailurePreservesResults: "passed",
    enterSearchDoesNotGrant: "passed",
    grantFailurePreservesSelection: "passed",
    emptyAndRetry: "passed",
    driveOutcomes: "passed",
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
}
