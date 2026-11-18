async function storeSoldoutJourney(page) {
  await page.getByRole("heading", { name: "Choose your gift box" }).waitFor();
  const matchaCard = page.locator(".shipping-catalog-item", {
    hasText: "Matcha cookie box",
  });
  return {
    soldOutBadge: await matchaCard.getByText("Sold out").isVisible(),
    matchaDisabled: await matchaCard
      .getByRole("button", { name: "Choose the Matcha cookie box" })
      .isDisabled(),
    gingerEnabled: await page
      .getByRole("button", { name: "Choose the Ginger cookie box" })
      .isEnabled(),
    fallbackSummary: (
      (await page.locator(".shipping-order-line").textContent()) ?? ""
    ).includes("Six-cookie box"),
  };
}
