async function cafeJourney(page) {
  await page
    .getByRole("heading", { name: "French pâtisserie, Taiwanese comfort" })
    .waitFor();
  const flavorMenu = page.locator(".cafe-flavor-menu");
  await flavorMenu
    .getByRole("heading", { name: "Four flavors, three ways" })
    .waitFor();
  const flavorMenuText = (
    await flavorMenu.locator(".cafe-flavor-grid").innerText()
  ).replaceAll("\n", " ");
  const flavorMenuImagePresent =
    (await flavorMenu.locator("img").getAttribute("src")) ===
    "/products/nuki-french-taiwanese-menu.webp";
  const language = page.locator(".language-select select");
  await language.selectOption("ja");
  await page
    .getByRole("heading", { name: "フランス菓子と台湾のやさしい味" })
    .waitFor();
  await language.selectOption("en");
  await page
    .getByRole("heading", { name: "French pâtisserie, Taiwanese comfort" })
    .waitFor();
  await page.getByRole("button", { name: "Add one Sesame latte" }).click();
  await page.getByRole("checkbox", { name: "Oat milk +¥100" }).check();
  await page.getByRole("button", { name: "Add one Ginger cookie" }).click();
  await page.getByRole("button", { name: "Add one Taro financier" }).click();
  const cart = page.getByRole("complementary", { name: "Cart" });
  await cart
    .locator(".basket-total strong")
    .filter({ hasText: "¥1,750" })
    .waitFor();
  await page.getByLabel("Email", { exact: true }).fill("buyer@example.test");
  await cart.getByRole("button", { name: "Checkout" }).click();
  await page
    .getByRole("heading", { name: "Ready to send to the café" })
    .waitFor();
  const quoteTotal = (
    (await page.locator(".totals .total-row dd").textContent()) ?? ""
  ).trim();
  await page.getByRole("button", { name: "Edit order" }).click();
  await page
    .getByRole("heading", { name: "French pâtisserie, Taiwanese comfort" })
    .waitFor();
  return {
    quoteTotal,
    flavorMenuText,
    flavorMenuImagePresent,
    languageRestored: (await language.inputValue()) === "en",
    restoredQuantity: (
      (await page.locator(".basket-count").textContent()) ?? ""
    ).trim(),
    restoredOatMilk: await page
      .getByRole("checkbox", { name: "Oat milk +¥100" })
      .isChecked(),
    noHorizontalOverflow: await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  };
}
