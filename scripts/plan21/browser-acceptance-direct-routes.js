async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const routes = [
    ["/portal/cafe-browser-lab", "Home"],
    ["/portal/cafe-browser-lab/commerce", "Commerce overview"],
    ["/portal/cafe-browser-lab/products", "Products"],
    ["/portal/cafe-browser-lab/products/product_croissant", "Butter Croissant"],
    ["/portal/cafe-browser-lab/inventory", "Inventory"],
    ["/portal/cafe-browser-lab/orders", "Orders"],
    ["/portal/cafe-browser-lab/orders/order_plan21_attention", "Order #1041"],
    ["/portal/cafe-browser-lab/operations", "Operations"],
    ["/portal/cafe-browser-lab/agents", "Agents"],
    ["/portal/cafe-browser-lab/integrations", "Integrations"],
    ["/portal/cafe-browser-lab/settings", "Workspace settings"],
  ];
  const results = [];
  for (const [path, heading] of routes) {
    await page.goto(`${origin}${path}`);
    const title = page
      .locator("h1#portal-page-title")
      .filter({ hasText: heading });
    await title.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () => document.activeElement?.id === "portal-page-title",
    );
    results.push({
      path: await page.evaluate(() => location.pathname),
      heading: ((await title.textContent()) ?? "").trim(),
      shell: await page.locator(".portal-shell").count(),
    });
  }
  return results;
};
