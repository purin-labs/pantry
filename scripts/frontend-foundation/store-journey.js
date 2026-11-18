async function storeJourney(page) {
  await page.getByRole("heading", { name: "Choose your gift box" }).waitFor();
  const cardCount = await page.locator(".shipping-catalog-item").count();
  await page.getByRole("button", { name: "Remove one Six-cookie box" }).click();

  await page
    .getByRole("button", { name: "Choose the Ginger cookie box" })
    .focus();
  await page.keyboard.press("Enter");
  const keyboardSelected = await page
    .getByRole("button", { name: "Remove one Ginger cookie box" })
    .isVisible();

  await page
    .getByRole("button", { name: "Choose the Matcha cookie box" })
    .click();
  const mixedBasket =
    (await page
      .getByRole("button", { name: "Remove one Ginger cookie box" })
      .count()) === 1 &&
    (await page
      .getByRole("button", { name: "Remove one Matcha cookie box" })
      .isVisible());
  await page
    .getByRole("button", { name: "Choose the Matcha cookie box" })
    .click();
  await page
    .getByRole("button", { name: "Remove one Ginger cookie box" })
    .click();
  const quantity = (
    (await page.locator(".quantity-stepper output").textContent()) ?? ""
  ).trim();

  await page
    .getByRole("button", { name: "Continue to delivery quote" })
    .click();
  const validationFocus = await page.evaluate(() => {
    const active = document.activeElement;
    return (
      active instanceof HTMLInputElement &&
      (active.closest("label")?.textContent ?? "").includes("Email")
    );
  });

  await page.getByLabel(/^Email/).fill("buyer@example.test");
  await page.getByLabel("Recipient name").fill("Aiko Tan");
  await page.getByLabel("Street address").fill("10 Bayfront Avenue");
  await page.getByLabel("Postal code").fill("018956");
  await page
    .getByRole("button", { name: "Continue to delivery quote" })
    .click();
  await page
    .getByRole("heading", { name: "Ready to send to Singapore" })
    .waitFor();
  const quoteTotal = (
    (await page.locator(".totals .total-row dd").textContent()) ?? ""
  ).trim();
  const carrierVisible = await page
    .getByText("Japan Post EMS Test (ems_test)", { exact: true })
    .isVisible();
  const matchaLineVisible = await page
    .getByText("Matcha cookie box")
    .first()
    .isVisible();

  await page.getByRole("button", { name: "Edit basket and address" }).click();
  await page.getByRole("heading", { name: "Choose your gift box" }).waitFor();
  const selectionRestored =
    (await page
      .getByRole("button", { name: "Remove one Matcha cookie box" })
      .isVisible()) &&
    (
      (await page.locator(".quantity-stepper output").textContent()) ?? ""
    ).trim() === quantity;
  await page.getByLabel("Recipient name").fill("Aiko Sato");
  await page.getByLabel("Postal code").fill("018957");

  const desktopFits = await page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("heading", { name: "Choose your gift box" }).waitFor();
  const mobileFits = await page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  await page.setViewportSize({ width: 1280, height: 720 });

  return {
    cardCount,
    keyboardSelected,
    mixedBasket,
    quantity,
    validationFocus,
    quoteTotal,
    carrierVisible,
    matchaLineVisible,
    selectionRestored,
    recipient: await page.getByLabel("Recipient name").inputValue(),
    postalCode: await page.getByLabel("Postal code").inputValue(),
    noHorizontalOverflow: desktopFits,
    mobileFits,
  };
}
