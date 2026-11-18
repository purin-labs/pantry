async function verifyPlan45And46(page) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/access-preview.html?scenario=populated&view=data_flow`,
  );
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Case", exact: true }),
    { value: "case:supplier-price-question" },
  );
  await page.getByRole("button", { name: "Confirm link", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Detach link", exact: true })
    .waitFor();
  const focused = await page.evaluate("document.activeElement?.id");
  if (focused !== "related-cases-selection")
    throw new Error("Review lost keyboard focus.");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page
    .getByText("case_delivery_exception · detached", { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Related Cases", exact: true })
    .screenshot({ path: "output/playwright/plan46-related-cases-mobile.png" });

  await page.goto(
    `${origin}/access-preview.html?scenario=viewer&view=data_flow`,
  );
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Case", exact: true }),
    { value: "case:supplier-price-question" },
  );
  await page
    .getByText("case_delivery_exception · suggested", { exact: true })
    .waitFor();
  if (
    await page
      .getByRole("button", { name: "Confirm link", exact: true })
      .count()
  )
    throw new Error("Viewer can review an CaseContextCollection relationship.");

  await page.goto(
    `${origin}/access-preview.html?scenario=fresh&view=data_flow`,
  );
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Case", exact: true }),
    { value: "case:supplier-price-question" },
  );
  await page
    .getByText("No related Cases are available to you for this Case.", {
      exact: true,
    })
    .waitFor();
  if (
    await page
      .getByRole("region", { name: "Related Cases", exact: true })
      .getByRole("article")
      .count()
  )
    throw new Error("Empty metadata response exposes a relationship.");

  await page.goto(`${origin}/chat-preview.html?conversation=shipping`);
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  const composer = page.getByRole("textbox", {
    name: "Message your AI",
    exact: true,
  });
  await composer.waitFor();
  await page.evaluate(`
    window.plan45Files = new DataTransfer();
    window.plan45Files.items.add(new File(["delivery facts"], "delivery.txt", { type: "text/plain" }));
    document.querySelector("form.chat-composer").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.plan45Files }));
  `);
  await page
    .getByRole("button", { name: "Remove delivery.txt", exact: true })
    .waitFor();
  await composer.focus();
  await page.evaluate(`
    window.plan45Paste = new DataTransfer();
    window.plan45Paste.items.add(new File(["menu facts"], "menu.txt", { type: "text/plain" }));
    document.querySelector("#chat-message").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: window.plan45Paste }));
  `);
  await page
    .getByRole("button", { name: "Remove menu.txt", exact: true })
    .waitFor();
  await composer.fill(
    "Keep this draft while rejecting an oversized selection.",
  );
  await page.evaluate(`
    window.plan45Limit = new DataTransfer();
    for (let index = 0; index < 11; index += 1)
      window.plan45Limit.items.add(new File(["x"], "extra-" + index + ".txt", { type: "text/plain" }));
    document.querySelector("form.chat-composer").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.plan45Limit }));
  `);
  await page
    .getByRole("alert")
    .filter({ hasText: "Attach up to 10 non-empty files" })
    .waitFor();
  if (await page.getByRole("button", { name: /^Remove extra-/ }).count())
    throw new Error("Rejected batch partially changed the selected files.");
  if (
    (await composer.inputValue()) !==
    "Keep this draft while rejecting an oversized selection."
  )
    throw new Error("Rejected files changed the draft.");
  await page
    .getByRole("button", { name: "Remove menu.txt", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  if (
    await page
      .getByRole("button", { name: "Remove menu.txt", exact: true })
      .count()
  )
    throw new Error("Keyboard removal failed.");
  await page
    .getByRole("button", { name: "Remove delivery.txt", exact: true })
    .waitFor();
  await page.screenshot({ path: "output/playwright/plan45-files-mobile.png" });
  return {
    relatedCases: "confirmed and detached with keyboard",
    viewerReview: "absent",
    hiddenMetadata: "empty",
    fileDrop: "accepted",
    filePaste: "accepted",
    overLimitBatch: "rejected atomically",
    draft: "retained",
    keyboardRemoval: "passed",
    viewport: "390x844",
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
