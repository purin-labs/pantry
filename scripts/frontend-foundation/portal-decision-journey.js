// Run after the Plan 21 fixture in the same Playwright CLI session.
// All data changes below belong to development previews.
async function verifyDecisionSurfaces(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-state-review";
  const checks = [];

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(
    `${origin}/commerce-preview.html?page=checkout&scenario=fresh`,
  );
  const trigger = page.getByRole("button", {
    name: "Review publication",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    "document.activeElement?.id === 'checkout-profile-review-title'",
  );
  const review = page.getByRole("region", {
    name: "Publish this profile?",
    exact: true,
  });
  const bounds = await review.boundingBox();
  if (bounds === null) throw new Error("The Checkout review is not visible.");
  for (const name of ["Cancel", "Publish revision"]) {
    const button = await review
      .getByRole("button", { name, exact: true })
      .boundingBox();
    if (
      button === null ||
      button.x < bounds.x ||
      button.x + button.width > bounds.x + bounds.width
    ) {
      throw new Error(`${name} extends outside the Checkout review.`);
    }
  }
  await page.screenshot({ path: `${artifacts}/checkout-confirm-after.png` });
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(
    "document.activeElement?.textContent === 'Review publication'",
  );
  checks.push(
    "Checkout review receives focus, keeps both actions within the narrow panel, and restores focus on cancel.",
  );

  await page.goto(
    `${origin}/brain-preview.html?view=knowledge&memory=memory_preview_sunday`,
  );
  await page.getByRole("button", { name: "Edit first", exact: true }).focus();
  await page.keyboard.press("Enter");
  const statement = page.getByRole("textbox", {
    name: "What to remember",
    exact: true,
  });
  await page.waitForFunction("document.activeElement?.tagName === 'TEXTAREA'");
  await statement.fill("The shop closes at 19:00 on Sundays.");
  await page
    .getByRole("button", { name: "Save for review", exact: true })
    .click();
  await page
    .getByText("Saved for review. It is not in use until someone accepts it.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("heading", {
      name: "The shop closes at 19:00 on Sundays.",
      exact: true,
    })
    .waitFor();
  if (
    await page
      .getByRole("button", { name: "Propose a replacement", exact: true })
      .count()
  ) {
    throw new Error("An edited memory became active before acceptance.");
  }
  await page.getByRole("button", { name: "Accept", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Propose a replacement", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Keep it", exact: true }).click();
  await page
    .getByRole("button", { name: "Propose a replacement", exact: true })
    .click();
  await page.waitForFunction("document.activeElement?.tagName === 'TEXTAREA'");
  await page.screenshot({ path: `${artifacts}/memory-edit-after.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(
    "document.activeElement?.classList.contains('brain-memory-statement')",
  );
  checks.push(
    "A memory edit stays pending until accepted; cancelling revoke keeps it active; the editor restores focus after cancel.",
  );

  await page.goto(`${origin}/portal/cafe-browser-lab/main/inventory`);
  await page.getByRole("button", { name: /Hokkaido pastry flour/ }).click();
  await page.getByRole("button", { name: "Count stock", exact: true }).click();
  const count = page.getByRole("dialog", { name: "Count stock", exact: true });
  await count.getByRole("spinbutton").fill("6.5");
  await count
    .getByRole("textbox", { name: /Explanation/ })
    .fill("Counted after morning prep.");
  await count.getByRole("button", { name: "Cancel", exact: true }).click();
  await count
    .getByText(
      "You have unsaved changes. Keep editing or discard the changes below.",
      { exact: true },
    )
    .waitFor();
  if ((await count.getByRole("spinbutton").inputValue()) !== "6.5") {
    throw new Error(
      "Cancelling the count discarded the draft without a decision.",
    );
  }
  await page.screenshot({ path: `${artifacts}/stock-discard-review.png` });
  const discardBounds = await count
    .getByRole("button", { name: "Discard changes", exact: true })
    .boundingBox();
  if (discardBounds === null) throw new Error("Discard is missing.");
  const discardTarget = await page.evaluate(
    `document.elementFromPoint(${discardBounds.x + discardBounds.width / 2}, ${discardBounds.y + discardBounds.height / 2})?.closest('button')?.textContent?.trim()`,
  );
  if (discardTarget !== "Discard changes")
    throw new Error("Discard is hidden behind the scroll edge.");
  await count
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await count.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Receive supplies", exact: true })
    .click();
  const receipt = page.getByRole("dialog", {
    name: "Receive supplies",
    exact: true,
  });
  await receipt.getByRole("spinbutton").first().waitFor();
  await receipt.getByRole("spinbutton").first().fill("2");
  await receipt.getByRole("button", { name: "Cancel", exact: true }).click();
  await receipt
    .getByRole("button", { name: "Discard changes", exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/receipt-after.png` });
  await receipt
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await receipt.waitFor({ state: "hidden" });

  await page.goto(`${origin}/portal/cafe-browser-lab/main/products`);
  await page.getByRole("button", { name: /Brown butter financier/ }).click();
  await page
    .getByRole("button", { name: "Request production", exact: true })
    .click();
  const production = page.getByRole("dialog");
  await production.getByRole("spinbutton").fill("48");
  await production.getByRole("button", { name: "Cancel", exact: true }).click();
  await production
    .getByRole("button", { name: "Discard changes", exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/production-discard-review.png` });
  await production
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await production.waitFor({ state: "hidden" });
  checks.push(
    "Stock dialogs load current data, preserve an unsaved count until explicit discard, and return to the item.",
  );
  return { status: "passed", checks, artifacts };
}
