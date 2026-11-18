// Run after the Plan 21 browser fixture in the same session.
async function reviewNavigation(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-navigation-review";
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(
    `${origin}/portal/cafe-browser-lab/main/settings?p21_provider=1`,
  );
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  const palette = page.getByRole("dialog", {
    name: "Search workspace pages",
    exact: true,
  });
  const search = palette.getByRole("combobox");
  await search.fill("no such page");
  await palette.getByRole("status").waitFor();
  await search.press("Enter");
  if (!(await palette.isVisible()))
    throw new Error("Empty search navigated away.");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${artifacts}/search-empty.png` });
  await search.fill("");
  await search.press("ArrowUp");
  const selected = await search.getAttribute("aria-activedescendant");
  if (
    selected !== (await palette.getByRole("option").last().getAttribute("id"))
  )
    throw new Error("Up did not wrap to the final result.");
  await search.press("Home");
  if (
    (await search.getAttribute("aria-activedescendant")) !==
    (await palette.getByRole("option").first().getAttribute("id"))
  )
    throw new Error("Home did not select the first result.");
  await search.fill("orders");
  const before = page.url();
  await search.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  if (!(await palette.isVisible()) || page.url() !== before)
    throw new Error("Text composition opened a page.");
  await page.screenshot({ path: `${artifacts}/search-composition.png` });
  await search.press("Enter");
  await page
    .getByRole("heading", { name: "Customer orders", exact: true })
    .waitFor();
  await page.getByText("Order #1041 · Aiko Sato", { exact: true }).waitFor();
  await page.waitForFunction(
    "document.activeElement?.id === 'portal-page-title'",
  );
  await page.screenshot({ path: `${artifacts}/search-orders-destination.png` });
  await page.keyboard.press("Meta+k");
  await palette.waitFor();
  await search.fill("brain");
  await search.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await page.waitForFunction(
    "document.activeElement?.getAttribute('aria-label') === 'Search workspace'",
  );

  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await page.getByRole("button", { name: /^Switch workspace:/ }).click();
  const workspaceSearch = page.getByRole("searchbox", {
    name: "Find a workspace",
    exact: true,
  });
  await workspaceSearch.fill("unmatched-workspace");
  await page
    .getByText("No organisations or workspaces found.", { exact: true })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/workspace-search-empty.png` });
  await workspaceSearch.fill("Riverside");
  await page.locator(".workspace-switcher-workspace").waitFor();
  await page.screenshot({ path: `${artifacts}/workspace-filtered.png` });
  await workspaceSearch.fill("");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Switch product:/ }).click();
  await page.getByRole("menu", { name: /^Switch product:/ }).waitFor();
  await page.screenshot({ path: `${artifacts}/product-menu-narrow.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  await palette.waitFor();
  await search.fill("stock");
  await palette.getByRole("option", { name: /Purchasing/ }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${artifacts}/search-wide-dark.png` });
  await search.fill("inventory");
  await palette
    .getByRole("option", { name: /Ingredients & supplies/ })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/search-route-term.png` });
  return {
    status: "passed",
    emptySearch: "passed",
    keyboardSelection: "passed",
    compositionGuard: "passed",
    routeFocus: "passed",
    closeFocus: "passed",
    workspaceAndProductMenus: "reviewed",
    artifacts,
  };
}
