// Run after scripts/plan21/browser-acceptance-fixture.js in the same CLI session.
// Real routes use the fixture APIs. Dedicated previews cover commerce records.
async function reviewPortalPages(page) {
  await page.unrouteAll();
  const origin = new URL(page.url()).origin;
  const workspace = "/portal/cafe-browser-lab/main";
  const artifacts = "output/playwright/ui-full-review";
  const workspacePages = [
    {
      name: "home",
      path: workspace,
      ready: "#home-commerce-aggregations-title",
    },
    {
      name: "settings",
      path: `${workspace}/settings`,
      ready: ".account-list .account-row",
    },
    {
      name: "products",
      path: `${workspace}/products`,
      ready: ".crm-table tbody tr",
    },
    {
      name: "inventory",
      path: `${workspace}/inventory`,
      ready: ".crm-table tbody tr",
    },
    {
      name: "production-requests",
      path: `${workspace}/production-requests`,
      ready: ".stock-production-request",
    },
    {
      name: "terminals",
      path: `${workspace}/terminals`,
      ready: ".terminal-row",
    },
    {
      name: "operations",
      path: `${workspace}/operations?p21_provider=1`,
      ready: "#operations-approvals-title",
    },
  ];
  const previewPages = [
    {
      name: "supplier-board",
      path: "/commerce-preview.html?page=suppliers",
      ready: ".commerce-board-card",
    },
    {
      name: "product-detail",
      path: "/commerce-preview.html?page=products&resource=product_financier",
      ready: "h1#portal-page-title",
    },
    {
      name: "order-detail",
      path: "/commerce-preview.html?page=orders&resource=ord_1041",
      ready: "h1#portal-page-title",
    },
    {
      name: "supplier-detail",
      path: "/commerce-preview.html?page=suppliers&resource=kyoto-roastery",
      ready: "h1#portal-page-title",
    },
    {
      name: "capabilities",
      path: "/access-preview.html?scenario=populated&view=capabilities",
      ready: ".access35-page",
    },
    {
      name: "data-flow",
      path: "/access-preview.html?scenario=populated&view=data_flow",
      ready: ".access35-page",
    },
    { name: "sign-in", path: "/sign-in", ready: ".signin-button" },
    { name: "privacy", path: "/docs/privacy", ready: ".public-doc-article" },
    { name: "terms", path: "/docs/terms", ready: ".public-doc-article" },
    { name: "deletion", path: "/docs/deletion", ready: ".public-doc-article" },
    { name: "contact", path: "/docs/contact", ready: ".public-doc-article" },
    {
      name: "identity",
      path: "/identity/link?token=ui-review",
      ready: ".invitation-facts",
    },
    { name: "missing-page", path: `${workspace}/missing`, ready: "h1" },
    { name: "ecommerce", path: "/ecommerce", ready: "#h2-eco-hero-title" },
  ];
  const pages = [...workspacePages, ...previewPages];
  const results = [];
  for (const entry of pages) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}${entry.path}`);
    await page.locator(entry.ready).first().waitFor();
    if (
      entry.name === "home" &&
      (await page
        .getByRole("heading", { name: "Apps and connectors", exact: true })
        .count())
    ) {
      throw new Error(
        "Active workspace Home still leads with the app catalog.",
      );
    }
    await page.screenshot({
      path: `${artifacts}/${entry.name}-wide-after.png`,
    });
    await page.setViewportSize({ width: 320, height: 800 });
    // Let responsive springs settle before recording the final layout.
    await page.waitForTimeout(450);
    if (
      await page.evaluate("document.documentElement.scrollWidth > innerWidth")
    ) {
      throw new Error(`${entry.name} exceeds the 320px viewport.`);
    }
    await page.screenshot({
      path: `${artifacts}/${entry.name}-narrow-after.png`,
    });
    results.push({ page: entry.name, wide: "reviewed", narrow: "fits" });
  }

  await page.goto(`${origin}${workspace}/inventory`);
  const search = page.getByRole("textbox", {
    name: "Search inventory",
    exact: true,
  });
  await search.fill("Hokkaido");
  const rows = page.locator(".crm-table tbody tr");
  if ((await rows.count()) !== 1)
    throw new Error("Inventory search did not narrow the stock list.");
  await page.getByRole("button", { name: /Hokkaido pastry flour/ }).click();
  await page
    .getByRole("heading", {
      name: "北海道産 薄力粉 · Hokkaido pastry flour",
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("heading", { name: "Incoming purchases", exact: true })
    .waitFor();
  await page.getByText("Hokkaido Flour Mill", { exact: true }).waitFor();
  await page.screenshot({ path: `${artifacts}/stock-detail-narrow.png` });
  await page
    .getByRole("button", { name: "Close", exact: true })
    .click();
  if ((await search.inputValue()) !== "Hokkaido")
    throw new Error("Closing stock detail lost the active search.");

  for (const entry of workspacePages) {
    await page.setViewportSize({ width: 720, height: 500 });
    await page.goto(`${origin}${entry.path}`);
    await page.locator(entry.ready).first().waitFor();
    await page.evaluate(
      "document.documentElement.dataset.portalTheme = 'dark'",
    );
    await page.waitForTimeout(450);
    await page.screenshot({
      path: `${artifacts}/${entry.name}-dark-compact.png`,
    });
  }
  return {
    status: "passed",
    pages: results,
    stockSearchAndReturn: "passed",
    compactDarkLayouts: 7,
    artifacts,
  };
}
