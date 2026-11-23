async (page) => {
  const routes = [
    ["/portal/cafe-browser-lab/commerce", "Commerce overview"],
    ["/portal/cafe-browser-lab/products", "Products"],
    ["/portal/cafe-browser-lab/inventory", "Inventory"],
    ["/portal/cafe-browser-lab/orders", "Orders"],
    ["/portal/cafe-browser-lab/operations", "Operations"],
    ["/portal/cafe-browser-lab/agents", "Agents"],
    ["/portal/cafe-browser-lab/integrations", "Integrations"],
    ["/portal/cafe-browser-lab/settings", "Workspace settings"],
  ];
  await page.evaluate(() => {
    globalThis.__plan21Shell = document.querySelector(".portal-shell");
  });
  const initialNavigationCount = await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  const visited = [];
  for (const [path, heading] of routes) {
    const link = page
      .locator(`nav[aria-label="Workspace pages"]:visible a[href="${path}"]`)
      .first();
    await link.waitFor({ state: "visible", timeout: 10_000 });
    await link.focus();
    await page.keyboard.press("Enter");
    await page
      .locator("h1#portal-page-title")
      .filter({ hasText: heading })
      .waitFor({ state: "visible", timeout: 10_000 });
    visited.push({
      path: page
        .url()
        .replace(/^https?:\/\/[^/]+/u, "")
        .split("?")[0],
      heading,
      focused: await page.evaluate(
        () => document.activeElement?.id === "portal-page-title",
      ),
    });
  }
  const home = page
    .locator(
      'nav[aria-label="Workspace pages"]:visible a[href="/portal/cafe-browser-lab"]',
    )
    .first();
  await home.focus();
  await page.keyboard.press("Enter");
  await page
    .locator("h1#portal-page-title")
    .filter({ hasText: "Home" })
    .waitFor({ state: "visible", timeout: 10_000 });
  const orders = page
    .locator(
      'nav[aria-label="Workspace pages"]:visible a[href="/portal/cafe-browser-lab/orders"]',
    )
    .first();
  await orders.waitFor({ state: "visible", timeout: 10_000 });
  await orders.focus();
  await page.keyboard.press("Enter");
  await page
    .locator("h1")
    .filter({ hasText: "Orders" })
    .waitFor({ state: "visible", timeout: 10_000 });
  return {
    path: page
      .url()
      .replace(/^https?:\/\/[^/]+/u, "")
      .split("?")[0],
    visited,
    sameShell: await page.evaluate(
      () =>
        globalThis.__plan21Shell === document.querySelector(".portal-shell"),
    ),
    navigationCount: await page.evaluate(
      () => performance.getEntriesByType("navigation").length,
    ),
    initialNavigationCount,
  };
};
