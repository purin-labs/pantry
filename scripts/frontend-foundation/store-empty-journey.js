async function storeEmptyJourney(page) {
  await page
    .getByRole("heading", { name: "Today’s selection is unavailable" })
    .waitFor();
  const emptyStateVisible = await page
    .getByText("No gift boxes are published right now.")
    .isVisible();
  page.__emptyShippingCatalog = false;
  await page.getByRole("button", { name: "Check again" }).click();
  await page.getByRole("heading", { name: "Choose your gift box" }).waitFor();
  return {
    emptyStateVisible,
    recovered: (await page.locator(".shipping-catalog-item").count()) > 0,
  };
}
